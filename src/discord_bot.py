"""Discord bot with slash commands and reaction-based voting system."""

import discord
from discord.ext import commands
import asyncio
import logging
from typing import List, Dict, Any, Optional
import aiohttp
from datetime import datetime
import math

from .database import get_db_manager
from .dns_monitor import get_dns_monitor
from .config import get_settings

logger = logging.getLogger(__name__)


class VotingManager:
    """Manages Discord reaction-based voting for IP addresses."""
    
    def __init__(self, db_manager):
        self.db = db_manager
        self.settings = get_settings()
    
    async def create_vote_session(self, channel, domain: str, unknown_ips: List[str], 
                                change_info: Dict[str, Any], all_ips: List[str]) -> Optional[int]:
        """Create a voting session with Discord message and reactions."""
        
        # Create embed for the voting message
        embed = discord.Embed(
            title=f"🔍 DNS change detected for {domain}",
            description="**Action Required:** Vote on whether the new IP addresses should be marked as known/expected",
            color=0xFFA500  # Orange color
        )
        
        embed.add_field(
            name="🆕 New IPs Requiring Vote",
            value="\n".join([f"• `{ip}`" for ip in unknown_ips]),
            inline=False
        )
        
        embed.add_field(
            name="📋 All Current IPs",
            value="\n".join([f"• `{ip}`" for ip in all_ips]),
            inline=False
        )
        
        if change_info.get('removed_ips'):
            embed.add_field(
                name="📤 IPs No Longer Resolving",
                value="\n".join([f"• `{ip}`" for ip in change_info['removed_ips']]),
                inline=False
            )
        
        embed.add_field(
            name="🗳️ How to Vote",
            value=(
                "✅ **Mark as Known** - These new IPs are legitimate/expected\n"
                "❌ **Keep as Unknown** - These IPs should trigger future alerts\n\n"
                f"Voting closes in {self.settings.vote_timeout_hours} hours or when "
                f"{self.settings.min_votes_required}+ votes reach {int(self.settings.majority_threshold * 100)}% majority"
            ),
            inline=False
        )
        
        embed.add_field(
            name="📊 Change Type",
            value=change_info.get('change_type', 'unknown').replace('_', ' ').title(),
            inline=True
        )
        
        embed.timestamp = datetime.utcnow()
        embed.set_footer(text="DNS Monitor Bot")
        
        # Send the message
        try:
            message = await channel.send(embed=embed)
            
            # Add reactions
            await message.add_reaction("✅")
            await message.add_reaction("❌")
            
            # Get domain info
            domain_info = await self.db.get_domain_by_name(domain)
            if not domain_info:
                logger.error(f"Domain {domain} not found in database")
                return None
            
            # Create vote session in database for each unknown IP
            # For simplicity, we'll create one session for the first IP
            # In a more complex implementation, you might handle multiple IPs differently
            primary_ip = unknown_ips[0] if unknown_ips else None
            if primary_ip:
                vote_session_id = await self.db.create_vote_session(
                    domain_info['id'], primary_ip, str(message.id)
                )
                
                logger.info(f"Created vote session {vote_session_id} for {domain} IP {primary_ip}")
                return vote_session_id
            
        except Exception as e:
            logger.error(f"Error creating vote session: {e}")
            return None
    
    async def handle_reaction(self, reaction, user) -> bool:
        """Handle a reaction on a voting message."""
        if user.bot:
            return False
        
        message_id = str(reaction.message.id)
        
        # Get vote session from database
        vote_session = await self.db.get_vote_session_by_message_id(message_id)
        if not vote_session or vote_session['is_resolved']:
            return False
        
        # Determine vote based on reaction
        vote = None
        if str(reaction.emoji) == "✅":
            vote = True  # Mark as known
        elif str(reaction.emoji) == "❌":
            vote = False  # Treat as alert
        else:
            return False
        
        # Add user vote to database
        success = await self.db.add_user_vote(
            vote_session['id'], str(user.id), vote
        )
        
        if success:
            logger.info(f"User {user.id} voted {vote} for session {vote_session['id']}")
            
            # Check if we should resolve the vote
            await self._check_vote_resolution(vote_session['id'], reaction.message)
            return True
        
        return False
    
    async def _check_vote_resolution(self, vote_session_id: int, message):
        """Check if a vote session should be resolved based on votes."""
        # Get updated vote session
        vote_session = await self.db.get_vote_session_by_message_id(str(message.id))
        if not vote_session or vote_session['is_resolved']:
            return
        
        total_votes = vote_session['total_votes']
        confirmed_votes = vote_session['confirmed_votes']
        rejected_votes = vote_session['rejected_votes']
        
        # Check if we have enough votes and a clear majority
        if total_votes >= self.settings.min_votes_required:
            if total_votes > 0:
                confirmed_ratio = confirmed_votes / total_votes
                rejected_ratio = rejected_votes / total_votes
                
                # Check for majority threshold
                if confirmed_ratio >= self.settings.majority_threshold:
                    await self._resolve_vote_session(vote_session_id, True, message, "majority voted to mark as known")
                elif rejected_ratio >= self.settings.majority_threshold:
                    await self._resolve_vote_session(vote_session_id, False, message, "majority voted to treat as alert")
    
    async def _resolve_vote_session(self, vote_session_id: int, decision: bool, 
                                  message, reason: str):
        """Resolve a vote session with the final decision."""
        try:
            # Update database
            await self.db.resolve_vote_session(vote_session_id, decision)
            
            # Update the Discord message
            embed = message.embeds[0] if message.embeds else discord.Embed()
            
            if decision:
                embed.color = 0x00FF00  # Green
                embed.title = f"✅ {embed.title.replace('🔍', '✅')}"
                result_text = "**Result: Marked as Known Addresses**\nFuture occurrences will be silently logged."
            else:
                embed.color = 0xFF0000  # Red
                embed.title = f"❌ {embed.title.replace('🔍', '❌')}"
                result_text = "**Result: Will Trigger Alerts**\nFuture occurrences will generate alert notifications."
            
            # Add result field
            embed.add_field(
                name="🏁 Voting Complete",
                value=f"{result_text}\n\n*Reason: {reason}*",
                inline=False
            )
            
            await message.edit(embed=embed)
            logger.info(f"Resolved vote session {vote_session_id} with decision: {decision}")
            
        except Exception as e:
            logger.error(f"Error resolving vote session {vote_session_id}: {e}")


class DomainListPaginator(discord.ui.View):
    """Pagination view for domain lists."""
    
    def __init__(self, domains: List[Dict[str, Any]], domains_per_page: int = 10):
        super().__init__(timeout=300)  # 5 minutes timeout
        self.domains = domains
        self.domains_per_page = domains_per_page
        self.total_pages = math.ceil(len(domains) / domains_per_page)
        self.current_page = 0
        
        # Update button states and select menu
        self._update_buttons()
    
    
    def _get_page_domains(self) -> List[Dict[str, Any]]:
        """Get domains for the current page."""
        start_idx = self.current_page * self.domains_per_page
        end_idx = start_idx + self.domains_per_page
        return self.domains[start_idx:end_idx]
    
    def _create_embed(self) -> discord.Embed:
        """Create embed for current page."""
        page_domains = self._get_page_domains()
        
        if not page_domains:
            embed = discord.Embed(
                title="📋 Monitored Domains",
                description="No domains are currently monitored.",
                color=0x808080
            )
            return embed
        
        embed = discord.Embed(
            title="📋 Monitored Domains",
            description=f"Page {self.current_page + 1} of {self.total_pages} • Monitoring {len(self.domains)} domain(s)",
            color=0x0099FF
        )
        
        domain_list = []
        for domain in page_domains:
            ip_count = len(domain.get('current_ips', []))
            known_count = domain.get('known_addresses_count', 0)
            coverage = f"{(known_count/ip_count*100) if ip_count > 0 else 0:.0f}%"
            
            # Add status indicators
            if ip_count == 0:
                status = "🔴"  # No IPs resolved
            elif known_count == ip_count:
                status = "🟢"  # Full coverage
            elif known_count > 0:
                status = "🟡"  # Partial coverage
            else:
                status = "⚪"  # No known addresses
            
            domain_list.append(f"{status} `{domain['domain']}` ({ip_count} IPs, {known_count} known, {coverage})")
        
        embed.add_field(
            name=f"Domains {self.current_page * self.domains_per_page + 1}-{min((self.current_page + 1) * self.domains_per_page, len(self.domains))}",
            value="\n".join(domain_list),
            inline=False
        )
        
        # Add legend
        embed.add_field(
            name="🔍 Status Legend",
            value="🟢 Full coverage • 🟡 Partial coverage • ⚪ No known IPs • 🔴 No IPs resolved",
            inline=False
        )
        
        return embed
    
    @discord.ui.button(label="⏮️", style=discord.ButtonStyle.secondary, disabled=True)
    async def first_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Go to first page."""
        try:
            self.current_page = 0
            self._update_buttons()
            embed = self._create_embed()
            await interaction.response.edit_message(embed=embed, view=self)
        except Exception as e:
            logger.error(f"Error in first button: {e}")
            try:
                await interaction.response.send_message("❌ Navigation error. Please use /list again.", ephemeral=True)
            except:
                pass
    
    @discord.ui.button(label="◀️", style=discord.ButtonStyle.primary, disabled=True)
    async def previous_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Go to previous page."""
        try:
            if self.current_page > 0:
                self.current_page -= 1
                self._update_buttons()
                embed = self._create_embed()
                await interaction.response.edit_message(embed=embed, view=self)
        except Exception as e:
            logger.error(f"Error in previous button: {e}")
            try:
                await interaction.response.send_message("❌ Navigation error. Please use /list again.", ephemeral=True)
            except:
                pass
    
    @discord.ui.button(label="▶️", style=discord.ButtonStyle.primary)
    async def next_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Go to next page."""
        try:
            if self.current_page < self.total_pages - 1:
                self.current_page += 1
                self._update_buttons()
                embed = self._create_embed()
                await interaction.response.edit_message(embed=embed, view=self)
        except Exception as e:
            logger.error(f"Error in next button: {e}")
            try:
                await interaction.response.send_message("❌ Navigation error. Please use /list again.", ephemeral=True)
            except:
                pass
    
    @discord.ui.button(label="⏭️", style=discord.ButtonStyle.secondary)
    async def last_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Go to last page."""
        try:
            self.current_page = self.total_pages - 1
            self._update_buttons()
            embed = self._create_embed()
            await interaction.response.edit_message(embed=embed, view=self)
        except Exception as e:
            logger.error(f"Error in last button: {e}")
            try:
                await interaction.response.send_message("❌ Navigation error. Please use /list again.", ephemeral=True)
            except:
                pass
    
    @discord.ui.button(label="🔄", style=discord.ButtonStyle.secondary)
    async def refresh_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Refresh the domain list."""
        try:
            # Defer the response to avoid interaction timeout
            await interaction.response.defer()
            
            # Get fresh domain data
            if dns_monitor:
                fresh_domains = await asyncio.wait_for(
                    dns_monitor.get_monitored_domains(), 
                    timeout=10.0
                )
                
                self.domains = fresh_domains
                self.total_pages = math.ceil(len(fresh_domains) / self.domains_per_page) if fresh_domains else 1
                
                # Adjust current page if needed
                if self.current_page >= self.total_pages:
                    self.current_page = max(0, self.total_pages - 1)
                
                self._update_buttons()
                embed = self._create_embed()
                
                # Use followup instead of edit_message to avoid conflicts
                await interaction.edit_original_response(embed=embed, view=self)
            else:
                await interaction.followup.send("❌ Service not ready for refresh.", ephemeral=True)
                
        except asyncio.TimeoutError:
            try:
                await interaction.followup.send("⏰ Refresh timed out. Please try again.", ephemeral=True)
            except:
                pass
        except Exception as e:
            logger.error(f"Error refreshing domain list: {e}")
            try:
                await interaction.followup.send(f"❌ Error refreshing: {str(e)}", ephemeral=True)
            except:
                # If followup also fails, try editing original response
                try:
                    await interaction.edit_original_response(content="❌ Refresh failed. Please use /list again.")
                except:
                    pass
    
    def _update_select_menu(self):
        """Update the domain select menu with current page domains."""
        # Remove existing select menu if any
        for item in self.children[:]:
            if isinstance(item, discord.ui.Select):
                self.remove_item(item)
        
        # Add new select menu with current page domains (limit to avoid Discord errors)
        if self.domains:
            page_domains = self._get_page_domains()
            if page_domains and len(page_domains) <= 25:  # Discord limit
                try:
                    select_menu = DomainRemoveSelect(page_domains, self)
                    self.add_item(select_menu)
                except Exception as e:
                    logger.error(f"Error creating select menu: {e}")
                    # Continue without select menu if there's an error
    
    def _update_buttons(self):
        """Update button states and select menu."""
        # Previous button
        self.previous_button.disabled = (self.current_page == 0)
        
        # Next button  
        self.next_button.disabled = (self.current_page >= self.total_pages - 1)
        
        # First/Last buttons
        self.first_button.disabled = (self.current_page == 0)
        self.last_button.disabled = (self.current_page >= self.total_pages - 1)
        
        # Update select menu
        self._update_select_menu()
    
    async def on_timeout(self):
        """Called when the view times out."""
        # Disable all buttons
        for item in self.children:
            item.disabled = True


class DomainRemoveSelect(discord.ui.Select):
    """Select menu for removing domains from the current page."""
    
    def __init__(self, domains: List[Dict[str, Any]], parent_view=None):
        self.domains = domains
        self.parent_paginator = parent_view
        
        # Create options for each domain on current page
        options = []
        for domain in domains:
            ip_count = len(domain.get('current_ips', []))
            known_count = domain.get('known_addresses_count', 0)
            
            # Status emoji
            if ip_count == 0:
                status = "🔴"
            elif known_count == ip_count:
                status = "🟢"
            elif known_count > 0:
                status = "🟡"
            else:
                status = "⚪"
            
            # Truncate long domain names for display
            display_name = domain['domain']
            if len(display_name) > 45:
                display_name = display_name[:42] + "..."
            
            options.append(discord.SelectOption(
                label=f"{status} {display_name}",
                description=f"{ip_count} IPs, {known_count} known",
                value=domain['domain']
            ))
        
        super().__init__(
            placeholder="🗑️ Select a domain to remove...",
            min_values=1,
            max_values=1,
            options=options
        )
    
    async def callback(self, interaction: discord.Interaction):
        """Handle domain removal selection."""
        try:
            if not self.values:
                await interaction.response.send_message("❌ No domain selected", ephemeral=True)
                return
                
            selected_domain = self.values[0]
            
            # Create confirmation embed
            embed = discord.Embed(
                title="⚠️ Confirm Domain Removal",
                description=f"Are you sure you want to remove `{selected_domain}` from monitoring?",
                color=0xFF6B00
            )
            
            embed.add_field(
                name="🔄 This will:",
                value="• Stop DNS monitoring for this domain\n• Preserve historical data\n• Remove from active monitoring list",
                inline=False
            )
            
            # Create confirmation view
            confirmation_view = DomainRemoveConfirmation(selected_domain, self.parent_paginator)
            
            await interaction.response.send_message(embed=embed, view=confirmation_view, ephemeral=True)
            
        except Exception as e:
            logger.error(f"Error in domain remove select callback: {e}")
            try:
                await interaction.response.send_message(f"❌ Error processing selection: {str(e)}", ephemeral=True)
            except:
                pass


class DomainRemoveConfirmation(discord.ui.View):
    """Confirmation dialog for domain removal."""
    
    def __init__(self, domain: str, parent_view):
        super().__init__(timeout=60)
        self.domain = domain
        self.parent_view = parent_view
    
    @discord.ui.button(label="✅ Yes, Remove", style=discord.ButtonStyle.danger)
    async def confirm_remove(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Confirm and execute domain removal."""
        try:
            # Perform domain removal
            if dns_monitor:
                result = await asyncio.wait_for(dns_monitor.remove_domain(self.domain), timeout=10.0)
                
                if result['success']:
                    # Success embed
                    embed = discord.Embed(
                        title="✅ Domain Removed",
                        description=f"Successfully removed `{self.domain}` from monitoring",
                        color=0x00FF00
                    )
                    
                    # Add note about refreshing the list
                    embed.add_field(
                        name="🔄 Next Steps",
                        value="Use the 🔄 Refresh button in the domain list to see updated results",
                        inline=False
                    )
                else:
                    # Failure embed
                    embed = discord.Embed(
                        title="❌ Removal Failed",
                        description=f"Failed to remove `{self.domain}`: {result['message']}",
                        color=0xFF0000
                    )
            else:
                embed = discord.Embed(
                    title="❌ Service Not Ready",
                    description="DNS monitor service is not available",
                    color=0xFF0000
                )
            
            # Disable all buttons in this confirmation dialog
            for item in self.children:
                item.disabled = True
            
            # Use followup instead of edit to avoid interaction issues
            await interaction.response.edit_message(embed=embed, view=self)
            
        except asyncio.TimeoutError:
            embed = discord.Embed(
                title="⏰ Removal Timed Out",
                description=f"Removal of `{self.domain}` timed out. Please try again.",
                color=0xFFA500
            )
            await interaction.response.edit_message(embed=embed, view=None)
        except Exception as e:
            embed = discord.Embed(
                title="❌ Removal Error",
                description=f"Error removing `{self.domain}`: {str(e)}",
                color=0xFF0000
            )
            await interaction.response.edit_message(embed=embed, view=None)
    
    @discord.ui.button(label="❌ Cancel", style=discord.ButtonStyle.secondary)
    async def cancel_remove(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Cancel domain removal."""
        embed = discord.Embed(
            title="🚫 Removal Cancelled",
            description=f"Domain `{self.domain}` will continue to be monitored",
            color=0x808080
        )
        
        # Disable all buttons
        for item in self.children:
            item.disabled = True
        
        await interaction.response.edit_message(embed=embed, view=self)
    
    async def on_timeout(self):
        """Handle timeout."""
        # Disable all buttons
        for item in self.children:
            item.disabled = True


# Bot description
description = """DNS Monitor Bot - Monitor DNS changes with user-controlled spam prevention"""

# Set up intents
intents = discord.Intents.none()
intents.guilds = True
intents.guild_messages = True  # Required to receive messages
intents.message_content = True  # Required for commands to work (must be enabled in developer portal)
intents.reactions = True  # Required for reaction handling


# Create bot instance
class DNSBot(commands.Bot):
    def __init__(self):
        super().__init__(
            command_prefix='!',
            description=description,
            intents=intents,
            help_command=None
        )
    
    async def setup_hook(self):
        """This will be executed when the bot starts the first time."""
        logger.info(f'Logged in as {self.user} (ID: {self.user.id})')
        
        # Sync slash commands once at startup
        try:
            synced = await self.tree.sync()
            logger.info(f"✅ Synced {len(synced)} slash command(s)")
        except Exception as e:
            logger.error(f"❌ Failed to sync slash commands: {e}")

bot = DNSBot()

# Global variables for services
db_manager = None
dns_monitor = None
voting_manager = None
settings = get_settings()


def is_allowed_channel(interaction: discord.Interaction) -> bool:
    """Check if the interaction is in the allowed channel."""
    if not settings.discord_channel_id:
        # If no specific channel is configured, allow in any channel
        return True
    
    try:
        allowed_channel_id = int(settings.discord_channel_id)
        return interaction.channel_id == allowed_channel_id
    except (ValueError, AttributeError):
        # If channel ID is invalid, allow in any channel
        logger.warning(f"Invalid DISCORD_CHANNEL_ID configured: {settings.discord_channel_id}")
        return True


async def check_channel_permission(interaction: discord.Interaction) -> bool:
    """
    Check if command can be used in current channel and respond with error if not.
    Returns True if allowed, False if not allowed (and already responded with error).
    """
    if not is_allowed_channel(interaction):
        channel_name = f"<#{settings.discord_channel_id}>" if settings.discord_channel_id else "the configured channel"
        embed = discord.Embed(
            title="❌ Wrong Channel",
            description=f"This command can only be used in {channel_name}",
            color=0xFF0000
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)
        return False
    return True


def set_services(db_manager_instance, dns_monitor_instance):
    """Set the service instances."""
    global db_manager, dns_monitor, voting_manager
    db_manager = db_manager_instance
    dns_monitor = dns_monitor_instance
    voting_manager = VotingManager(db_manager)
    logger.info("Services set for Discord bot")


@bot.event
async def on_ready():
    """Bot is ready - this can be called multiple times."""
    logger.info('Bot is ready!')
    
    # Update bot status
    activity = discord.Activity(
        type=discord.ActivityType.watching,
        name="DNS changes | Use /help"
    )
    await bot.change_presence(activity=activity)


@bot.event
async def on_message(message):
    """Process messages and commands."""
    if message.author.bot:
        return
    
    # Process commands
    await bot.process_commands(message)


@bot.tree.error
async def on_app_command_error(interaction: discord.Interaction, error):
    """Handle slash command errors."""
    logger.error(f"Slash command error: {error}")
    
    try:
        if not interaction.response.is_done():
            await interaction.response.send_message(f"❌ Command error: {str(error)}", ephemeral=True)
        else:
            await interaction.followup.send(f"❌ Command error: {str(error)}", ephemeral=True)
    except Exception as e:
        logger.error(f"Failed to send error response: {e}")


# Slash Commands
@bot.tree.command(name="ping", description="Test bot response time and service health")
async def ping_slash(interaction: discord.Interaction):
    """Test bot response time and service health."""
    if not await check_channel_permission(interaction):
        return
        
    import time
    start_time = time.time()
    
    await interaction.response.send_message("🏓 Pong! Checking service health...")
    
    # Test service connectivity
    try:
        # Test database connection
        db_start = time.time()
        if db_manager:
            await asyncio.wait_for(db_manager.get_active_domains(), timeout=5.0)
            db_time = (time.time() - db_start) * 1000
            db_status = f"🟢 Database: {db_time:.0f}ms"
        else:
            db_status = "🔴 Database: Not connected"
        
        # Test DNS monitor
        dns_start = time.time()
        if dns_monitor:
            domains = await asyncio.wait_for(dns_monitor.get_monitored_domains(), timeout=5.0)
            dns_time = (time.time() - dns_start) * 1000
            dns_status = f"🟢 DNS Monitor: {dns_time:.0f}ms ({len(domains)} domains)"
        else:
            dns_status = "🔴 DNS Monitor: Not connected"
        
        total_time = (time.time() - start_time) * 1000
        
        embed = discord.Embed(
            title="🏓 Service Health Check",
            description=f"Total response time: {total_time:.0f}ms",
            color=0x00FF00
        )
        
        embed.add_field(
            name="📊 Service Status",
            value=f"{db_status}\n{dns_status}",
            inline=False
        )
        
        # Add performance indicators
        if total_time < 1000:
            performance = "🟢 Excellent"
        elif total_time < 3000:
            performance = "🟡 Good"
        elif total_time < 5000:
            performance = "🟠 Slow"
        else:
            performance = "🔴 Poor"
        
        embed.add_field(
            name="⚡ Performance",
            value=performance,
            inline=True
        )
        
        await interaction.edit_original_response(content=None, embed=embed)
        
    except asyncio.TimeoutError:
        embed = discord.Embed(
            title="⏰ Service Health Check - Timeout",
            description="Some services are responding slowly",
            color=0xFFA500
        )
        embed.add_field(
            name="⚠️ Status",
            value="Services may be under heavy load. Try again in a moment.",
            inline=False
        )
        await interaction.edit_original_response(content=None, embed=embed)
        
    except Exception as e:
        embed = discord.Embed(
            title="❌ Service Health Check - Error",
            description="Error checking service health",
            color=0xFF0000
        )
        embed.add_field(
            name="🔧 Error Details",
            value=str(e)[:1000],  # Limit error message length
            inline=False
        )
        await interaction.edit_original_response(content=None, embed=embed)


@bot.tree.command(name="help", description="Show help information")
async def help_slash(interaction: discord.Interaction):
    """Show help information."""
    if not await check_channel_permission(interaction):
        return
        
    embed = discord.Embed(
        title="🤖 DNS Monitor Bot Help",
        description="Monitor DNS changes with user-controlled spam prevention",
        color=0x0099FF
    )
    
    embed.add_field(
        name="📋 Slash Commands",
        value=(
            "`/ping` - Test if bot is responding\n"
            "`/add domain:<domain>` - Add single domain to monitoring\n"
            "`/add-bulk domains:<domain1,domain2,domain3>` - Add multiple domains\n"
            "`/remove domain:<domain>` - Remove single domain from monitoring\n"
            "`/remove-bulk domains:<domain1,domain2,domain3>` - Remove multiple domains\n"
            "`/remove-all confirm:<yes>` - Remove ALL domains (requires confirmation)\n"
            "`/list` - List all monitored domains (with pagination & remove buttons)\n"
            "`/info domain:<domain>` - Get comprehensive domain information\n"
            "`/resolve-votes action:<approve-all|reject-all|list>` - Manage pending votes\n"
            "`/status domain:<domain>` - Check current DNS status\n"
            "`/help` - Show this help message"
        ),
        inline=False
    )
    
    embed.add_field(
        name="🗳️ Voting System",
        value=(
            "When new IP addresses are detected, vote:\n"
            "✅ **Mark as Known** - Silent logging\n"
            "❌ **Treat as Alert** - Generate alerts"
        ),
        inline=False
    )
    
    embed.add_field(
        name="💡 Examples",
        value=(
            "**Add single:** `/add domain:example.com`\n"
            "**Add multiple:** `/add-bulk domains:github.com,discord.com,reddit.com`\n"
            "**Remove multiple:** `/remove-bulk domains:old1.com,old2.com`\n"
            "**Remove all:** `/remove-all confirm:yes`\n"
            "**Domain info:** `/info domain:example.com`\n"
            "**Resolve votes:** `/resolve-votes action:approve-all`\n"
            "**Check status:** `/status domain:example.com`"
        ),
        inline=False
    )
    
    await interaction.response.send_message(embed=embed)


@bot.tree.command(name="list", description="List all monitored domains with pagination")
async def list_slash(interaction: discord.Interaction):
    """List all monitored domains with pagination support."""
    if not await check_channel_permission(interaction):
        return
        
    # Send immediate response to prevent timeout
    await interaction.response.send_message("🔍 Loading monitored domains...")
    
    if not dns_monitor or not db_manager:
        await interaction.edit_original_response(content="❌ Service not ready. Please wait.")
        return
    
    try:
        domains = await asyncio.wait_for(dns_monitor.get_monitored_domains(), timeout=15.0)
        
        if not domains:
            embed = discord.Embed(
                title="📋 Monitored Domains",
                description="No domains are currently monitored.",
                color=0x808080
            )
            await interaction.edit_original_response(content=None, embed=embed)
        else:
            # Create paginator
            paginator = DomainListPaginator(domains, domains_per_page=10)
            embed = paginator._create_embed()
            
            # If only one page, don't show pagination buttons
            if paginator.total_pages <= 1:
                # Remove all navigation buttons, keep only refresh
                paginator.clear_items()
                paginator.add_item(paginator.refresh_button)
            
            await interaction.edit_original_response(content=None, embed=embed, view=paginator)
        
    except asyncio.TimeoutError:
        await interaction.edit_original_response(content="⏰ Request timed out after 15 seconds. The service might be busy or experiencing high load. Please try again in a moment.")
    except Exception as e:
        logger.error(f"List slash command error: {e}")
        await interaction.edit_original_response(content="❌ Error listing domains")


@bot.tree.command(name="add", description="Add a domain to DNS monitoring")
async def add_slash(interaction: discord.Interaction, domain: str):
    """Add a domain to DNS monitoring."""
    if not await check_channel_permission(interaction):
        return
        
    # Send immediate response to prevent timeout
    await interaction.response.send_message(f"🔍 Adding domain `{domain}` to monitoring... (This may take up to 20 seconds)")
    
    if not dns_monitor or not db_manager:
        await interaction.edit_original_response(content="❌ Service not ready. Please wait.")
        return
    
    try:
        result = await asyncio.wait_for(dns_monitor.add_domain(domain, str(interaction.user.id)), timeout=20.0)
        
        if result['success']:
            embed = discord.Embed(
                title="✅ Domain Added",
                description=result['message'],
                color=0x00FF00
            )
            if result.get('initial_ips'):
                embed.add_field(
                    name="Initial IPs",
                    value="\n".join([f"• `{ip}`" for ip in result['initial_ips']]),
                    inline=False
                )
        else:
            embed = discord.Embed(
                title="❌ Failed to Add Domain",
                description=result['message'],
                color=0xFF0000
            )
        
        await interaction.edit_original_response(content=None, embed=embed)
        
    except asyncio.TimeoutError:
        await interaction.edit_original_response(content=f"⏰ Adding `{domain}` timed out after 20 seconds. The domain might be slow to resolve or unreachable. Please try again later.")
    except Exception as e:
        logger.error(f"Add slash command error: {e}")
        await interaction.edit_original_response(content=f"❌ Error adding domain: {str(e)}")


@bot.tree.command(name="add-bulk", description="Add multiple domains to DNS monitoring (comma-separated)")
async def add_bulk_slash(interaction: discord.Interaction, domains: str):
    """Add multiple domains to DNS monitoring."""
    if not await check_channel_permission(interaction):
        return
        
    # Send immediate response to prevent timeout
    await interaction.response.send_message("🔍 Processing bulk domain addition... (This may take several minutes for multiple domains)")
    
    if not dns_monitor or not db_manager:
        await interaction.edit_original_response(content="❌ Service not ready. Please wait.")
        return
    
    try:
        # Parse and clean domain list
        domain_list = [domain.strip() for domain in domains.split(',') if domain.strip()]
        
        if not domain_list:
            await interaction.edit_original_response(content="❌ No valid domains provided. Please use comma-separated format: `domain1.com, domain2.com`")
            return
        
        
        # Process each domain
        results = []
        successful = 0
        failed = 0
        
        for i, domain in enumerate(domain_list):
            # Update progress for longer operations
            if len(domain_list) > 3 and i > 0:
                progress = f"Processing domain {i+1}/{len(domain_list)}: `{domain}`..."
                try:
                    await interaction.edit_original_response(content=progress)
                except:
                    pass  # Don't fail if we can't update progress
            
            try:
                result = await asyncio.wait_for(
                    dns_monitor.add_domain(domain, str(interaction.user.id)), 
                    timeout=15.0
                )
                results.append({
                    'domain': domain,
                    'success': result['success'],
                    'message': result['message'],
                    'initial_ips': result.get('initial_ips', [])
                })
                
                if result['success']:
                    successful += 1
                else:
                    failed += 1
                    
            except asyncio.TimeoutError:
                results.append({
                    'domain': domain,
                    'success': False,
                    'message': 'DNS resolution timeout',
                    'initial_ips': []
                })
                failed += 1
            except Exception as e:
                results.append({
                    'domain': domain,
                    'success': False,
                    'message': str(e),
                    'initial_ips': []
                })
                failed += 1
        
        # Create summary embed
        if successful > 0 and failed == 0:
            color = 0x00FF00  # Green - all successful
            title = "✅ Bulk Addition Successful"
        elif successful > 0 and failed > 0:
            color = 0xFFA500  # Orange - partial success
            title = "⚠️ Bulk Addition Partially Successful"
        else:
            color = 0xFF0000  # Red - all failed
            title = "❌ Bulk Addition Failed"
        
        embed = discord.Embed(
            title=title,
            description=f"Processed {len(domain_list)} domains: {successful} successful, {failed} failed",
            color=color
        )
        
        # Add successful domains
        if successful > 0:
            success_list = []
            for result in results:
                if result['success']:
                    ip_count = len(result['initial_ips'])
                    success_list.append(f"• `{result['domain']}` ({ip_count} IPs)")
            
            if success_list:
                # Split into chunks if too long
                success_text = "\n".join(success_list)
                if len(success_text) > 1024:
                    success_text = "\n".join(success_list[:5]) + f"\n... and {len(success_list)-5} more"
                
                embed.add_field(
                    name=f"✅ Successfully Added ({successful})",
                    value=success_text,
                    inline=False
                )
        
        # Add failed domains
        if failed > 0:
            failure_list = []
            for result in results:
                if not result['success']:
                    failure_list.append(f"• `{result['domain']}`: {result['message']}")
            
            if failure_list:
                # Split into chunks if too long
                failure_text = "\n".join(failure_list)
                if len(failure_text) > 1024:
                    failure_text = "\n".join(failure_list[:5]) + f"\n... and {len(failure_list)-5} more"
                
                embed.add_field(
                    name=f"❌ Failed to Add ({failed})",
                    value=failure_text,
                    inline=False
                )
        
        # Add usage tip
        embed.add_field(
            name="💡 Tip",
            value="Use `/list` to see all monitored domains or `/status domain:<domain>` to check individual domains",
            inline=False
        )
        
        await interaction.edit_original_response(content=None, embed=embed)
        
    except Exception as e:
        logger.error(f"Add-bulk slash command error: {e}")
        await interaction.edit_original_response(content=f"❌ Error processing bulk addition: {str(e)}")


@bot.tree.command(name="remove-bulk", description="Remove multiple domains from DNS monitoring (comma-separated)")
async def remove_bulk_slash(interaction: discord.Interaction, domains: str):
    """Remove multiple domains from DNS monitoring."""
    if not await check_channel_permission(interaction):
        return
        
    # Send immediate response to prevent timeout
    await interaction.response.send_message("🗑️ Processing bulk domain removal...")
    
    if not dns_monitor:
        await interaction.edit_original_response(content="❌ Service not ready. Please wait.")
        return
    
    try:
        # Parse and clean domain list
        domain_list = [domain.strip() for domain in domains.split(',') if domain.strip()]
        
        if not domain_list:
            await interaction.edit_original_response(content="❌ No valid domains provided. Please use comma-separated format: `domain1.com, domain2.com`")
            return
        
        if len(domain_list) > 20:  # Higher limit for removal since it's less resource intensive
            await interaction.edit_original_response(content="❌ Too many domains. Please limit to 20 domains per bulk operation.")
            return
        
        # Process each domain
        results = []
        successful = 0
        failed = 0
        
        for domain in domain_list:
            try:
                result = await asyncio.wait_for(dns_monitor.remove_domain(domain), timeout=10.0)
                results.append({
                    'domain': domain,
                    'success': result['success'],
                    'message': result['message']
                })
                
                if result['success']:
                    successful += 1
                else:
                    failed += 1
                    
            except asyncio.TimeoutError:
                results.append({
                    'domain': domain,
                    'success': False,
                    'message': 'Operation timeout'
                })
                failed += 1
            except Exception as e:
                results.append({
                    'domain': domain,
                    'success': False,
                    'message': str(e)
                })
                failed += 1
        
        # Create summary embed
        if successful > 0 and failed == 0:
            color = 0x00FF00  # Green - all successful
            title = "✅ Bulk Removal Successful"
        elif successful > 0 and failed > 0:
            color = 0xFFA500  # Orange - partial success
            title = "⚠️ Bulk Removal Partially Successful"
        else:
            color = 0xFF0000  # Red - all failed
            title = "❌ Bulk Removal Failed"
        
        embed = discord.Embed(
            title=title,
            description=f"Processed {len(domain_list)} domains: {successful} removed, {failed} failed",
            color=color
        )
        
        # Add successful removals
        if successful > 0:
            success_list = []
            for result in results:
                if result['success']:
                    success_list.append(f"• `{result['domain']}`")
            
            if success_list:
                success_text = "\n".join(success_list)
                if len(success_text) > 1024:
                    success_text = "\n".join(success_list[:10]) + f"\n... and {len(success_list)-10} more"
                
                embed.add_field(
                    name=f"✅ Successfully Removed ({successful})",
                    value=success_text,
                    inline=False
                )
        
        # Add failed removals
        if failed > 0:
            failure_list = []
            for result in results:
                if not result['success']:
                    failure_list.append(f"• `{result['domain']}`: {result['message']}")
            
            if failure_list:
                failure_text = "\n".join(failure_list)
                if len(failure_text) > 1024:
                    failure_text = "\n".join(failure_list[:10]) + f"\n... and {len(failure_list)-10} more"
                
                embed.add_field(
                    name=f"❌ Failed to Remove ({failed})",
                    value=failure_text,
                    inline=False
                )
        
        # Add usage tip
        embed.add_field(
            name="💡 Tip",
            value="Use `/list` to see remaining monitored domains",
            inline=False
        )
        
        await interaction.edit_original_response(content=None, embed=embed)
        
    except Exception as e:
        logger.error(f"Remove-bulk slash command error: {e}")
        await interaction.edit_original_response(content=f"❌ Error processing bulk removal: {str(e)}")


@bot.tree.command(name="remove-all", description="Remove ALL domains from monitoring (requires confirmation)")
async def remove_all_slash(interaction: discord.Interaction, confirm: str = ""):
    """Remove all domains from DNS monitoring with confirmation."""
    if not await check_channel_permission(interaction):
        return
        
    # Send immediate response to prevent timeout
    await interaction.response.send_message("🗑️ Processing remove-all request...")
    
    if not dns_monitor or not db_manager:
        await interaction.edit_original_response(content="❌ Service not ready. Please wait.")
        return
    
    try:
        # Check current domains first
        current_domains = await dns_monitor.get_monitored_domains()
        
        if not current_domains:
            embed = discord.Embed(
                title="ℹ️ No Domains to Remove",
                description="There are currently no domains being monitored.",
                color=0x808080
            )
            await interaction.edit_original_response(content=None, embed=embed)
            return
        
        # Require explicit confirmation
        if confirm.lower() != "yes":
            embed = discord.Embed(
                title="⚠️ Remove All Domains - Confirmation Required",
                description=f"**WARNING:** This will remove ALL {len(current_domains)} monitored domains!",
                color=0xFF6B00  # Orange warning color
            )
            
            domain_list = []
            for domain in current_domains[:10]:  # Show first 10
                ip_count = len(domain.get('current_ips', []))
                domain_list.append(f"• `{domain['domain']}` ({ip_count} IPs)")
            
            if domain_list:
                domains_text = "\n".join(domain_list)
                if len(current_domains) > 10:
                    domains_text += f"\n... and {len(current_domains)-10} more domains"
                
                embed.add_field(
                    name="📋 Domains to be Removed",
                    value=domains_text,
                    inline=False
                )
            
            embed.add_field(
                name="🔄 To Confirm",
                value="Run the command again with: `/remove-all confirm:yes`",
                inline=False
            )
            
            embed.add_field(
                name="⚠️ This Action",
                value="• Removes all domains from monitoring\n• Stops DNS checking for all domains\n• Preserves historical data\n• **Cannot be easily undone**",
                inline=False
            )
            
            await interaction.edit_original_response(content=None, embed=embed)
            return
        
        # Confirmed removal - process all domains
        results = []
        successful = 0
        failed = 0
        
        for domain_info in current_domains:
            domain_name = domain_info['domain']
            try:
                result = await dns_monitor.remove_domain(domain_name)
                results.append({
                    'domain': domain_name,
                    'success': result['success'],
                    'message': result['message']
                })
                
                if result['success']:
                    successful += 1
                else:
                    failed += 1
                    
            except Exception as e:
                results.append({
                    'domain': domain_name,
                    'success': False,
                    'message': str(e)
                })
                failed += 1
        
        # Create results embed
        if successful > 0 and failed == 0:
            color = 0x00FF00  # Green
            title = "✅ All Domains Removed Successfully"
        elif successful > 0 and failed > 0:
            color = 0xFFA500  # Orange
            title = "⚠️ Partial Removal Completed"
        else:
            color = 0xFF0000  # Red
            title = "❌ Remove All Failed"
        
        embed = discord.Embed(
            title=title,
            description=f"Processed {len(current_domains)} domains: {successful} removed, {failed} failed",
            color=color
        )
        
        if successful > 0:
            embed.add_field(
                name="✅ Removal Summary",
                value=f"Successfully removed {successful} domains from monitoring",
                inline=False
            )
        
        if failed > 0:
            failure_list = []
            for result in results:
                if not result['success']:
                    failure_list.append(f"• `{result['domain']}`: {result['message']}")
            
            if failure_list:
                failure_text = "\n".join(failure_list[:5])  # Show first 5 failures
                if len(failure_list) > 5:
                    failure_text += f"\n... and {len(failure_list)-5} more"
                
                embed.add_field(
                    name=f"❌ Failed to Remove ({failed})",
                    value=failure_text,
                    inline=False
                )
        
        embed.add_field(
            name="📊 System Status",
            value="Use `/list` to verify remaining domains (should be empty if all successful)",
            inline=False
        )
        
        await interaction.edit_original_response(content=None, embed=embed)
        
    except Exception as e:
        logger.error(f"Remove-all slash command error: {e}")
        await interaction.edit_original_response(content=f"❌ Error processing remove-all: {str(e)}")


@bot.tree.command(name="remove", description="Remove a domain from DNS monitoring")
async def remove_slash(interaction: discord.Interaction, domain: str):
    """Remove a domain from DNS monitoring."""
    if not await check_channel_permission(interaction):
        return
        
    # Send immediate response to prevent timeout
    await interaction.response.send_message(f"🗑️ Removing domain `{domain}` from monitoring...")
    
    if not dns_monitor:
        await interaction.edit_original_response(content="❌ Service not ready. Please wait.")
        return
    
    try:
        result = await asyncio.wait_for(dns_monitor.remove_domain(domain), timeout=10.0)
        
        color = 0x00FF00 if result['success'] else 0xFF0000
        title = "✅ Domain Removed" if result['success'] else "❌ Failed to Remove Domain"
        
        embed = discord.Embed(
            title=title,
            description=result['message'],
            color=color
        )
        
        await interaction.edit_original_response(content=None, embed=embed)
        
    except asyncio.TimeoutError:
        await interaction.edit_original_response(content=f"⏰ Removing `{domain}` timed out. Please try again.")
    except Exception as e:
        logger.error(f"Remove slash command error: {e}")
        await interaction.edit_original_response(content=f"❌ Error removing domain: {str(e)}")


@bot.tree.command(name="resolve-votes", description="Manually resolve pending votes for IP addresses")
async def resolve_votes_slash(interaction: discord.Interaction, action: str = "list"):
    """Manually resolve pending votes for IP addresses."""
    if not await check_channel_permission(interaction):
        return
        
    await interaction.response.send_message(f"🗳️ Managing pending votes...")
    
    if not db_manager:
        await interaction.edit_original_response(content="❌ Service not ready. Please wait.")
        return
    
    try:
        # Get unresolved votes
        async with db_manager.get_connection() as conn:
            unresolved_votes = await conn.fetch("""
                SELECT av.id, d.domain, av.ip_address, av.total_votes, 
                       av.confirmed_votes, av.rejected_votes, av.created_at, av.expires_at
                FROM address_votes av
                JOIN domains d ON d.id = av.domain_id
                WHERE av.is_resolved = FALSE
                ORDER BY av.created_at DESC
            """)
        
        if not unresolved_votes:
            embed = discord.Embed(
                title="✅ No Pending Votes",
                description="There are no unresolved voting sessions.",
                color=0x00FF00
            )
            await interaction.edit_original_response(content=None, embed=embed)
            return
        
        if action.lower() == "approve-all":
            # Approve all pending votes
            approved_count = 0
            for vote in unresolved_votes:
                success = await db_manager.resolve_vote_session(vote['id'], True)
                if success:
                    approved_count += 1
            
            embed = discord.Embed(
                title="✅ Bulk Vote Resolution",
                description=f"Approved {approved_count} of {len(unresolved_votes)} pending votes",
                color=0x00FF00
            )
            embed.add_field(
                name="🔄 Next Steps",
                value="These IPs are now marked as known and won't trigger future votes",
                inline=False
            )
            
        elif action.lower() == "reject-all":
            # Reject all pending votes
            rejected_count = 0
            for vote in unresolved_votes:
                success = await db_manager.resolve_vote_session(vote['id'], False)
                if success:
                    rejected_count += 1
            
            embed = discord.Embed(
                title="❌ Bulk Vote Resolution", 
                description=f"Rejected {rejected_count} of {len(unresolved_votes)} pending votes",
                color=0xFF0000
            )
            embed.add_field(
                name="🔄 Next Steps",
                value="These IPs will continue to trigger alerts when detected",
                inline=False
            )
            
        else:
            # List pending votes
            embed = discord.Embed(
                title="🗳️ Pending Vote Sessions",
                description=f"Found {len(unresolved_votes)} unresolved votes requiring attention",
                color=0xFFA500
            )
            
            vote_list = []
            for vote in unresolved_votes[:10]:  # Show first 10
                domain = vote['domain']
                ip = vote['ip_address']
                created = vote['created_at'].strftime('%m/%d %H:%M')
                expires = vote['expires_at'].strftime('%m/%d %H:%M')
                
                vote_list.append(f"• `{domain}` - `{ip}` (created {created})")
            
            if vote_list:
                embed.add_field(
                    name="📋 Pending Votes",
                    value="\\n".join(vote_list),
                    inline=False
                )
            
            if len(unresolved_votes) > 10:
                embed.add_field(
                    name="📊 Note",
                    value=f"Showing first 10 of {len(unresolved_votes)} pending votes",
                    inline=False
                )
            
            embed.add_field(
                name="🔧 Resolution Options",
                value=(
                    "`/resolve-votes action:approve-all` - Approve all pending votes\\n"
                    "`/resolve-votes action:reject-all` - Reject all pending votes\\n"
                    "`/resolve-votes` - Show this list again"
                ),
                inline=False
            )
        
        await interaction.edit_original_response(content=None, embed=embed)
        
    except Exception as e:
        logger.error(f"Resolve-votes slash command error: {e}")
        await interaction.edit_original_response(content=f"❌ Error managing votes: {str(e)}")


@bot.tree.command(name="info", description="Get comprehensive information about a monitored domain")
async def info_slash(interaction: discord.Interaction, domain: str):
    """Get comprehensive information about a monitored domain."""
    if not await check_channel_permission(interaction):
        return
        
    # Send immediate response to prevent timeout
    await interaction.response.send_message(f"🔍 Gathering comprehensive info for `{domain}`... (This may take up to 15 seconds)")
    
    if not dns_monitor or not db_manager:
        await interaction.edit_original_response(content="❌ Service not ready. Please wait.")
        return
    
    try:
        # Get domain information
        domain_info = await db_manager.get_domain_by_name(domain)
        if not domain_info:
            embed = discord.Embed(
                title="❌ Domain Not Found",
                description=f"Domain `{domain}` is not being monitored.",
                color=0xFF0000
            )
            embed.add_field(
                name="💡 Tip",
                value=f"Use `/add domain:{domain}` to start monitoring this domain",
                inline=False
            )
            await interaction.edit_original_response(content=None, embed=embed)
            return
        
        domain_id = domain_info['id']
        
        # Gather all information concurrently
        current_status_task = asyncio.create_task(
            asyncio.wait_for(dns_monitor.check_domain_once(domain), timeout=15.0)
        )
        
        async with db_manager.get_connection() as conn:
            # Get DNS history (last 10 records)
            dns_history = await conn.fetch("""
                SELECT ip_addresses, ttl, dns_status, checked_at, change_detected, 
                       change_type, previous_ips
                FROM dns_records 
                WHERE domain_id = $1 
                ORDER BY checked_at DESC 
                LIMIT 10
            """, domain_id)
            
            # Get known addresses
            known_addresses = await conn.fetch("""
                SELECT ip_address, added_by_user_id, added_at, vote_message_id, is_confirmed
                FROM known_addresses 
                WHERE domain_id = $1 AND is_confirmed = TRUE
                ORDER BY added_at DESC
            """, domain_id)
            
            # Get recent notifications
            recent_notifications = await conn.fetch("""
                SELECT notification_type, title, content, sent_at, requires_user_action
                FROM notifications 
                WHERE domain_id = $1 
                ORDER BY sent_at DESC 
                LIMIT 5
            """, domain_id)
            
            # Get active voting sessions
            active_votes = await conn.fetch("""
                SELECT ip_address, total_votes, confirmed_votes, rejected_votes, 
                       created_at, expires_at
                FROM address_votes 
                WHERE domain_id = $1 AND is_resolved = FALSE
                ORDER BY created_at DESC
            """, domain_id)
        
        # Wait for current status
        try:
            current_status = await current_status_task
        except asyncio.TimeoutError:
            current_status = {"error": "DNS lookup timed out"}
        except Exception as e:
            current_status = {"error": str(e)}
        
        # Create comprehensive embed
        embed = discord.Embed(
            title=f"📊 Domain Information: {domain}",
            description=f"Comprehensive overview of monitored domain",
            color=0x0099FF
        )
        
        # Basic domain info
        added_by = domain_info.get('added_by', 'Unknown')
        added_at = domain_info.get('added_at')
        if added_at:
            added_date = added_at.strftime('%Y-%m-%d %H:%M UTC')
        else:
            added_date = 'Unknown'
        
        embed.add_field(
            name="📋 Basic Info",
            value=f"**Added by:** {added_by}\n**Added on:** {added_date}\n**Static domain:** {'Yes' if domain_info.get('is_static') else 'No'}",
            inline=False
        )
        
        # Current DNS status
        if "error" not in current_status:
            current_ips = current_status.get('ip_addresses', [])
            ttl = current_status.get('ttl', 'Unknown')
            
            ip_status = []
            for ip in current_ips[:5]:  # Show first 5 IPs
                # Check if IP is known
                is_known = any(str(ka['ip_address']) == ip for ka in known_addresses)
                status_icon = "🟢" if is_known else "⚪"
                ip_status.append(f"{status_icon} `{ip}`")
            
            if len(current_ips) > 5:
                ip_status.append(f"... and {len(current_ips) - 5} more")
            
            embed.add_field(
                name="🌐 Current DNS Status",
                value=f"**IPs ({len(current_ips)}):**\n" + "\n".join(ip_status) + f"\n**TTL:** {ttl}",
                inline=False
            )
        else:
            embed.add_field(
                name="🌐 Current DNS Status",
                value=f"❌ {current_status['error']}",
                inline=False
            )
        
        # Known addresses
        if known_addresses:
            known_list = []
            for ka in known_addresses[:5]:  # Show first 5
                added_by_user = ka['added_by_user_id'] or 'System'
                added_date = ka['added_at'].strftime('%m/%d') if ka['added_at'] else 'Unknown'
                known_list.append(f"• `{ka['ip_address']}` (by {added_by_user} on {added_date})")
            
            if len(known_addresses) > 5:
                known_list.append(f"... and {len(known_addresses) - 5} more")
            
            embed.add_field(
                name=f"✅ Known Addresses ({len(known_addresses)})",
                value="\n".join(known_list),
                inline=False
            )
        else:
            embed.add_field(
                name="✅ Known Addresses (0)",
                value="No known addresses configured",
                inline=False
            )
        
        # Recent changes
        if dns_history:
            changes = []
            for record in dns_history[:3]:  # Show last 3 changes
                checked_date = record['checked_at'].strftime('%m/%d %H:%M')
                change_type = record['change_type'] or 'check'
                ip_count = len(record['ip_addresses']) if record['ip_addresses'] else 0
                
                if record['change_detected']:
                    change_icon = "🔄"
                    change_desc = f"{change_type.replace('_', ' ').title()}"
                else:
                    change_icon = "✓"
                    change_desc = "No change"
                
                changes.append(f"{change_icon} {checked_date}: {change_desc} ({ip_count} IPs)")
            
            embed.add_field(
                name="📈 Recent Activity",
                value="\n".join(changes),
                inline=False
            )
        
        # Active votes
        if active_votes:
            vote_list = []
            for vote in active_votes:
                ip = vote['ip_address']
                total = vote['total_votes']
                confirmed = vote['confirmed_votes']
                rejected = vote['rejected_votes']
                expires = vote['expires_at'].strftime('%m/%d %H:%M')
                vote_list.append(f"• `{ip}`: {confirmed}✅ {rejected}❌ (expires {expires})")
            
            embed.add_field(
                name=f"🗳️ Active Votes ({len(active_votes)})",
                value="\n".join(vote_list),
                inline=False
            )
        
        # Recent notifications
        if recent_notifications:
            notif_list = []
            for notif in recent_notifications[:3]:
                sent_date = notif['sent_at'].strftime('%m/%d %H:%M')
                notif_type = notif['notification_type']
                action_required = "🔔" if notif['requires_user_action'] else "ℹ️"
                notif_list.append(f"{action_required} {sent_date}: {notif_type}")
            
            embed.add_field(
                name="📢 Recent Notifications",
                value="\n".join(notif_list),
                inline=False
            )
        
        # Add legend
        embed.add_field(
            name="🔍 Legend",
            value="🟢 Known IP • ⚪ Unknown IP • 🔄 Change detected • ✓ Routine check • 🔔 Action required",
            inline=False
        )
        
        await interaction.edit_original_response(content=None, embed=embed)
        
    except asyncio.TimeoutError:
        await interaction.edit_original_response(content=f"⏰ Info gathering for `{domain}` timed out after 15 seconds. Please try again later.")
    except Exception as e:
        logger.error(f"Info slash command error: {e}")
        await interaction.edit_original_response(content=f"❌ Error gathering domain info: {str(e)}")


@bot.tree.command(name="status", description="Check current DNS status of a domain")
async def status_slash(interaction: discord.Interaction, domain: str):
    """Check current DNS status of a domain."""
    if not await check_channel_permission(interaction):
        return
        
    # Send immediate response to prevent timeout
    await interaction.response.send_message(f"🔍 Checking DNS status for `{domain}`... (This may take up to 15 seconds)")
    
    if not dns_monitor:
        await interaction.edit_original_response(content="❌ Service not ready. Please wait.")
        return
    
    try:
        result = await asyncio.wait_for(dns_monitor.check_domain_once(domain), timeout=15.0)
        
        if 'error' in result:
            embed = discord.Embed(
                title="❌ DNS Check Failed",
                description=f"Could not resolve `{domain}`: {result['error']}",
                color=0xFF0000
            )
        else:
            embed = discord.Embed(
                title="📡 DNS Status",
                description=f"Current DNS info for `{domain}`",
                color=0x00FF00
            )
            
            if result.get('ip_addresses'):
                ips = result['ip_addresses'][:5]  # Limit to prevent large messages
                embed.add_field(
                    name="Current IPs",
                    value="\n".join([f"• `{ip}`" for ip in ips]),
                    inline=False
                )
                if len(result['ip_addresses']) > 5:
                    embed.add_field(
                        name="Note",
                        value=f"Showing first 5 of {len(result['ip_addresses'])} IPs",
                        inline=False
                    )
            
            if result.get('ttl'):
                embed.add_field(name="TTL", value=str(result['ttl']), inline=True)
        
        await interaction.edit_original_response(content=None, embed=embed)
        
    except asyncio.TimeoutError:
        await interaction.edit_original_response(content=f"⏰ DNS lookup for `{domain}` timed out after 15 seconds. The domain might be slow to resolve, unreachable, or experiencing issues. Please try again later.")
    except Exception as e:
        logger.error(f"Status slash command error: {e}")
        await interaction.edit_original_response(content=f"❌ Error checking domain status: {str(e)}")


# Event handlers
@bot.event
async def on_reaction_add(reaction, user):
    """Handle reaction additions for voting."""
    if user.bot:
        return
    
    if voting_manager:
        await voting_manager.handle_reaction(reaction, user)


@bot.event
async def on_reaction_remove(reaction, user):
    """Handle reaction removals for voting."""
    if user.bot:
        return
    
    # For simplicity, we're not handling reaction removals
    # In a more sophisticated system, you might want to update votes
    pass


# Utility functions
async def send_webhook_notification(embed: discord.Embed, content: str = None):
    """Send notification via Discord webhook."""
    webhook_url = settings.discord_webhook_url
    if not webhook_url:
        logger.warning("No webhook URL configured")
        return
    
    webhook_data = {
        "embeds": [embed.to_dict()],
        "username": "DNS Monitor",
        "avatar_url": "https://cdn.discordapp.com/attachments/1234567890/dns-monitor-avatar.png"
    }
    
    if content:
        webhook_data["content"] = content
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(webhook_url, json=webhook_data) as response:
                if response.status == 204:
                    logger.debug("Webhook notification sent successfully")
                else:
                    logger.error(f"Webhook failed with status {response.status}")
    except Exception as e:
        logger.error(f"Error sending webhook notification: {e}")


async def notify_dns_change_with_voting(domain: str, unknown_ips: List[str],
                                      change_info: Dict[str, Any], all_ips: List[str]):
    """Send DNS change notification that requires voting."""
    # Use configured channel ID if available, otherwise find first available channel
    channel = None
    
    if settings.discord_channel_id:
        # Try to get the specific channel by ID
        try:
            channel = bot.get_channel(int(settings.discord_channel_id))
            if channel and not channel.permissions_for(channel.guild.me).send_messages:
                logger.warning(f"Bot doesn't have permission to send messages in configured channel {settings.discord_channel_id}")
                channel = None
        except (ValueError, AttributeError) as e:
            logger.error(f"Invalid channel ID configured: {settings.discord_channel_id} - {e}")
    
    # Fallback to finding any available channel if no specific channel configured or channel not found
    if not channel:
        for guild in bot.guilds:
            for ch in guild.text_channels:
                if ch.permissions_for(guild.me).send_messages:
                    channel = ch
                    break
            if channel:
                break
    
    if not channel:
        logger.error("No suitable channel found for voting notification")
        return
    
    # Create voting session
    if voting_manager:
        vote_session_id = await voting_manager.create_vote_session(
            channel, domain, unknown_ips, change_info, all_ips
        )
        
        if vote_session_id:
            logger.info(f"Created voting notification for {domain} in channel {channel.name}")
        else:
            logger.error(f"Failed to create voting notification for {domain}")


# Create bot instance
def create_bot():
    """Create and return the bot instance."""
    return bot


async def get_discord_bot():
    """Get the bot instance."""
    return bot