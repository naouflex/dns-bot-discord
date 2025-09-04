"""DNS monitoring logic with change detection and user-driven address management."""

import asyncio
import logging
from typing import List, Dict, Any, Optional, Set
from datetime import datetime

from .database import get_db_manager
from .dns_resolver import get_dns_resolver
from .config import get_settings

logger = logging.getLogger(__name__)


class ChangeDetector:
    """Detects and analyzes DNS changes."""
    
    @staticmethod
    def detect_changes(old_ips: List[str], new_ips: List[str]) -> Dict[str, Any]:
        """
        Detect and classify changes between old and new IP addresses.
        
        Returns:
            Dict with change information including type and details
        """
        old_set = set(old_ips) if old_ips else set()
        new_set = set(new_ips) if new_ips else set()
        
        if old_set == new_set:
            return {
                'has_change': False,
                'change_type': None,
                'added_ips': [],
                'removed_ips': [],
                'unchanged_ips': list(old_set)
            }
        
        added_ips = list(new_set - old_set)
        removed_ips = list(old_set - new_set)
        unchanged_ips = list(old_set & new_set)
        
        # Determine change type
        if not old_ips:
            change_type = 'initial'
        elif not new_ips:
            change_type = 'complete_removal'
        elif not unchanged_ips:
            change_type = 'complete'
        elif added_ips and removed_ips:
            change_type = 'replacement'
        elif added_ips:
            change_type = 'addition'
        elif removed_ips:
            change_type = 'removal'
        else:
            change_type = 'unknown'
        
        return {
            'has_change': True,
            'change_type': change_type,
            'added_ips': added_ips,
            'removed_ips': removed_ips,
            'unchanged_ips': unchanged_ips
        }


class KnownAddressManager:
    """Manages user-driven known address database."""
    
    def __init__(self, db_manager):
        self.db = db_manager
    
    async def filter_unknown_ips(self, domain_id: int, ip_addresses: List[str]) -> List[str]:
        """Filter out known IP addresses, returning only unknown ones."""
        if not ip_addresses:
            return []
        
        unknown_ips = []
        for ip in ip_addresses:
            if not await self.db.is_known_address(domain_id, ip):
                unknown_ips.append(ip)
        
        return unknown_ips
    
    async def get_known_addresses(self, domain_id: int) -> List[str]:
        """Get all known addresses for a domain."""
        return await self.db.get_known_addresses(domain_id)
    
    async def add_known_address(self, domain_id: int, ip_address: str, 
                              added_by_user_id: str, vote_message_id: Optional[str] = None) -> int:
        """Add a known address for a domain."""
        return await self.db.add_known_address(domain_id, ip_address, added_by_user_id, vote_message_id)


class DNSMonitor:
    """Main DNS monitoring service with user-driven spam prevention."""
    
    def __init__(self):
        self.settings = get_settings()
        self.db_manager = None
        self.dns_resolver = None
        self.change_detector = ChangeDetector()
        self.known_address_manager = None
        self._running = False
        self._monitor_task: Optional[asyncio.Task] = None
    
    async def initialize(self):
        """Initialize the DNS monitor."""
        self.db_manager = await get_db_manager()
        self.dns_resolver = await get_dns_resolver()
        self.known_address_manager = KnownAddressManager(self.db_manager)
        
        await self.db_manager.initialize()
        await self.dns_resolver.initialize()
        
        logger.info("DNS Monitor initialized")
    
    async def close(self):
        """Close the DNS monitor."""
        await self.stop_monitoring()
        
        if self.dns_resolver:
            await self.dns_resolver.close()
        if self.db_manager:
            await self.db_manager.close()
        
        logger.info("DNS Monitor closed")
    
    async def start_monitoring(self):
        """Start the DNS monitoring loop."""
        if self._running:
            logger.warning("DNS monitoring is already running")
            return
        
        self._running = True
        self._monitor_task = asyncio.create_task(self._monitoring_loop())
        logger.info("DNS monitoring started")
    
    async def stop_monitoring(self):
        """Stop the DNS monitoring loop."""
        if not self._running:
            return
        
        self._running = False
        
        if self._monitor_task:
            self._monitor_task.cancel()
            try:
                await self._monitor_task
            except asyncio.CancelledError:
                pass
        
        logger.info("DNS monitoring stopped")
    
    async def _monitoring_loop(self):
        """Main monitoring loop that checks domains periodically."""
        logger.info(f"Starting DNS monitoring loop with {self.settings.check_interval_seconds}s interval")
        
        while self._running:
            try:
                await self._check_all_domains()
                
                # Clean up expired votes periodically
                await self.db_manager.cleanup_expired_votes()
                
            except Exception as e:
                logger.error(f"Error in monitoring loop: {e}")
            
            # Wait for next check interval
            try:
                await asyncio.sleep(self.settings.check_interval_seconds)
            except asyncio.CancelledError:
                break
    
    async def _check_all_domains(self):
        """Check all active domains for DNS changes."""
        domains = await self.db_manager.get_active_domains()
        
        if not domains:
            logger.debug("No active domains to monitor")
            return
        
        logger.info(f"Checking {len(domains)} domains for DNS changes")
        
        # Resolve all domains concurrently
        domain_names = [domain['domain'] for domain in domains]
        dns_responses = await self.dns_resolver.resolve_multiple_domains(domain_names)
        
        # Process each domain's response
        for domain in domains:
            domain_name = domain['domain']
            dns_response = dns_responses.get(domain_name)
            
            if dns_response:
                await self._process_domain_response(domain, dns_response)
    
    async def _process_domain_response(self, domain: Dict[str, Any], dns_response):
        """Process DNS response for a single domain."""
        domain_id = domain['id']
        domain_name = domain['domain']
        
        try:
            # Get the previous DNS record
            previous_record = await self.db_manager.get_latest_dns_record(domain_id)
            previous_ips = previous_record['ip_addresses'] if previous_record else []
            
            # Detect changes
            change_info = self.change_detector.detect_changes(previous_ips, dns_response.ip_addresses)
            
            # Store the new DNS record
            record_id = await self.db_manager.add_dns_record(
                domain_id=domain_id,
                ip_addresses=dns_response.ip_addresses,
                ttl=dns_response.ttl,
                dns_status=dns_response.status,
                soa_serial=dns_response.soa_serial,
                nameserver=dns_response.nameserver,
                admin_email=dns_response.admin_email,
                change_detected=change_info['has_change'],
                change_type=change_info['change_type'],
                previous_ips=previous_ips
            )
            
            # If there's a change, process it
            if change_info['has_change'] and change_info['change_type'] != 'initial':
                await self._handle_dns_change(domain, change_info, dns_response)
            
            logger.debug(f"Processed {domain_name}: {len(dns_response.ip_addresses)} IPs, "
                        f"change: {change_info['has_change']}")
            
        except Exception as e:
            logger.error(f"Error processing {domain_name}: {e}")
            
            # Store error record
            await self.db_manager.add_dns_record(
                domain_id=domain_id,
                ip_addresses=[],
                dns_status=2,  # SERVFAIL
                change_detected=False
            )
    
    async def _handle_dns_change(self, domain: Dict[str, Any], change_info: Dict[str, Any], dns_response):
        """Handle a detected DNS change with user-driven address management."""
        domain_id = domain['id']
        domain_name = domain['domain']
        
        # Get added IPs (new unknown addresses)
        added_ips = change_info.get('added_ips', [])
        
        if not added_ips:
            # No new IPs, just log the change
            logger.info(f"DNS change detected for {domain_name}: {change_info['change_type']} "
                       f"(no new IPs to evaluate)")
            return
        
        # Filter out already known addresses
        unknown_ips = await self.known_address_manager.filter_unknown_ips(domain_id, added_ips)
        
        if not unknown_ips:
            # All new IPs are already known, silent logging
            logger.info(f"DNS change detected for {domain_name}: all new IPs are known addresses")
            return
        
        # Unknown IPs detected - this requires user action
        logger.info(f"Unknown IP addresses detected for {domain_name}: {unknown_ips}")
        
        # Create database notification record
        await self._create_voting_notification(domain, change_info, unknown_ips, dns_response)
        
        # Trigger Discord voting notification
        await self._trigger_discord_voting(domain_name, unknown_ips, change_info, dns_response.ip_addresses)
    
    async def _create_voting_notification(self, domain: Dict[str, Any], change_info: Dict[str, Any],
                                        unknown_ips: List[str], dns_response):
        """Create a notification that requires user voting."""
        domain_name = domain['domain']
        
        # Create notification content
        title = f"🔍 New IP addresses detected for {domain_name}"
        
        content_parts = [
            f"**Domain:** {domain_name}",
            f"**Change Type:** {change_info['change_type']}",
            f"**New Unknown IPs:** {', '.join(unknown_ips)}",
            f"**All Current IPs:** {', '.join(dns_response.ip_addresses)}",
            "",
            "**Action Required:** React with ✅ to mark as known addresses, ❌ to treat as alerts"
        ]
        
        if change_info.get('removed_ips'):
            content_parts.insert(-2, f"**Removed IPs:** {', '.join(change_info['removed_ips'])}")
        
        content = "\n".join(content_parts)
        
        # Store notification in database
        await self.db_manager.add_notification(
            domain_id=domain['id'],
            notification_type='vote_request',
            title=title,
            content=content,
            requires_user_action=True
        )
        
        logger.info(f"Created voting notification for {domain_name} with {len(unknown_ips)} unknown IPs")
    
    async def _trigger_discord_voting(self, domain_name: str, unknown_ips: List[str], 
                                    change_info: Dict[str, Any], all_ips: List[str]):
        """Trigger Discord voting notification."""
        try:
            # Import here to avoid circular imports
            from .discord_bot import notify_dns_change_with_voting
            
            logger.info(f"Triggering Discord voting for {domain_name} with {len(unknown_ips)} unknown IPs")
            await notify_dns_change_with_voting(domain_name, unknown_ips, change_info, all_ips)
            
        except Exception as e:
            logger.error(f"Failed to trigger Discord voting for {domain_name}: {e}")
            # Don't raise the exception - we don't want DNS monitoring to fail if Discord is down
    
    async def check_domain_once(self, domain_name: str) -> Dict[str, Any]:
        """Check a single domain once and return the result."""
        domain = await self.db_manager.get_domain_by_name(domain_name)
        if not domain:
            return {
                'error': f"Domain {domain_name} not found in monitoring list"
            }
        
        dns_response = await self.dns_resolver.resolve_domain(domain_name)
        
        if not dns_response.is_successful:
            return {
                'domain': domain_name,
                'error': dns_response.error,
                'status': dns_response.status
            }
        
        # Get known addresses
        known_addresses = await self.known_address_manager.get_known_addresses(domain['id'])
        
        return {
            'domain': domain_name,
            'ip_addresses': dns_response.ip_addresses,
            'ttl': dns_response.ttl,
            'nameserver': dns_response.nameserver,
            'admin_email': dns_response.admin_email,
            'known_addresses': known_addresses,
            'timestamp': dns_response.timestamp.isoformat()
        }
    
    async def add_domain(self, domain_name: str, added_by: Optional[str] = None, 
                        is_static: bool = False) -> Dict[str, Any]:
        """Add a new domain to monitoring."""
        try:
            # Add to database
            domain_id = await self.db_manager.add_domain(domain_name, is_static, added_by)
            
            # Perform initial DNS check to establish baseline
            dns_response = await self.dns_resolver.resolve_domain(domain_name)
            
            if dns_response.is_successful:
                # Store initial DNS record (no change detection for first record)
                await self.db_manager.add_dns_record(
                    domain_id=domain_id,
                    ip_addresses=dns_response.ip_addresses,
                    ttl=dns_response.ttl,
                    dns_status=dns_response.status,
                    soa_serial=dns_response.soa_serial,
                    nameserver=dns_response.nameserver,
                    admin_email=dns_response.admin_email,
                    change_detected=False,
                    change_type='initial'
                )
                
                # Add initial IP addresses as known addresses to prevent them from triggering voting
                for ip in dns_response.ip_addresses:
                    try:
                        await self.known_address_manager.add_known_address(
                            domain_id, ip, added_by or 'system'
                        )
                        logger.info(f"Added initial IP {ip} as known address for {domain_name}")
                    except Exception as e:
                        logger.warning(f"Failed to add initial IP {ip} as known address: {e}")
                
                return {
                    'success': True,
                    'domain': domain_name,
                    'domain_id': domain_id,
                    'initial_ips': dns_response.ip_addresses,
                    'message': f"Domain {domain_name} added to monitoring with {len(dns_response.ip_addresses)} IP addresses (marked as known)"
                }
            else:
                return {
                    'success': False,
                    'domain': domain_name,
                    'domain_id': domain_id,
                    'error': dns_response.error,
                    'message': f"Domain {domain_name} added but initial DNS check failed"
                }
                
        except Exception as e:
            logger.error(f"Error adding domain {domain_name}: {e}")
            return {
                'success': False,
                'domain': domain_name,
                'error': str(e),
                'message': f"Failed to add domain {domain_name}"
            }
    
    async def remove_domain(self, domain_name: str) -> Dict[str, Any]:
        """Remove a domain from monitoring."""
        try:
            removed = await self.db_manager.remove_domain(domain_name)
            
            if removed:
                return {
                    'success': True,
                    'domain': domain_name,
                    'message': f"Domain {domain_name} removed from monitoring"
                }
            else:
                return {
                    'success': False,
                    'domain': domain_name,
                    'message': f"Domain {domain_name} not found or already inactive"
                }
                
        except Exception as e:
            logger.error(f"Error removing domain {domain_name}: {e}")
            return {
                'success': False,
                'domain': domain_name,
                'error': str(e),
                'message': f"Failed to remove domain {domain_name}"
            }
    
    async def get_monitored_domains(self) -> List[Dict[str, Any]]:
        """Get list of all monitored domains with their status."""
        domains = await self.db_manager.get_active_domains()
        
        result = []
        for domain in domains:
            # Get latest DNS record
            latest_record = await self.db_manager.get_latest_dns_record(domain['id'])
            
            domain_info = {
                'id': domain['id'],
                'domain': domain['domain'],
                'is_static': domain['is_static'],
                'added_by': domain['added_by'],
                'added_at': domain['added_at'].isoformat() if domain['added_at'] else None,
                'last_checked': None,
                'current_ips': [],
                'known_addresses_count': 0
            }
            
            if latest_record:
                domain_info.update({
                    'last_checked': latest_record['checked_at'].isoformat(),
                    'current_ips': latest_record['ip_addresses'] or []
                })
            
            # Get known addresses count
            known_addresses = await self.known_address_manager.get_known_addresses(domain['id'])
            domain_info['known_addresses_count'] = len(known_addresses)
            
            result.append(domain_info)
        
        return result


# Global DNS monitor instance
dns_monitor = DNSMonitor()


async def get_dns_monitor() -> DNSMonitor:
    """Get the global DNS monitor instance."""
    return dns_monitor
