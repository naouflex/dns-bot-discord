"""Main entry point for DNS Monitor Bot."""

import asyncio
import logging
import signal
import sys
from pathlib import Path
from datetime import datetime
from aiohttp import web

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from src.config import get_settings
from src.database import get_db_manager
from src.dns_monitor import get_dns_monitor
from src.discord_bot import get_discord_bot, set_services


# Configure logging
def setup_logging():
    """Set up logging configuration."""
    settings = get_settings()
    
    log_level = getattr(logging, settings.log_level.upper(), logging.INFO)
    
    # Create logs directory if it doesn't exist
    logs_dir = Path("logs")
    logs_dir.mkdir(exist_ok=True)
    
    # Configure logging format
    log_format = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    
    # Set up file handler
    #file_handler = logging.FileHandler(logs_dir / "dns_monitor.log")
    #file_handler.setLevel(log_level)
    #file_handler.setFormatter(logging.Formatter(log_format))
    
    # Set up console handler
    console_handler = logging.StreamHandler()
    console_handler.setLevel(log_level)
    console_handler.setFormatter(logging.Formatter(log_format))
    
    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    #root_logger.addHandler(file_handler)
    root_logger.addHandler(console_handler)
    
    # Reduce discord.py logging noise
    logging.getLogger('discord').setLevel(logging.WARNING)
    logging.getLogger('discord.http').setLevel(logging.WARNING)
    
    return logging.getLogger(__name__)


class HealthCheckServer:
    """Simple HTTP server for health checks."""
    
    def __init__(self, port=8080):
        self.port = port
        self.app = web.Application()
        self.runner = None
        self.site = None
        self.logger = logging.getLogger(__name__)
        self._setup_routes()
    
    def _setup_routes(self):
        """Set up health check routes."""
        self.app.router.add_get('/health', self._health_check)
        self.app.router.add_get('/ready', self._readiness_check)
    
    async def _health_check(self, request):
        """Basic health check endpoint."""
        return web.json_response({'status': 'healthy', 'timestamp': datetime.now().isoformat()})
    
    async def _readiness_check(self, request):
        """Readiness check endpoint."""
        return web.json_response({'status': 'ready', 'timestamp': datetime.now().isoformat()})
    
    async def start(self):
        """Start the health check server."""
        self.logger.info(f"Starting health check server on port {self.port}")
        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, '0.0.0.0', self.port)
        await self.site.start()
        self.logger.info(f"✅ Health check server started on port {self.port}")
    
    async def stop(self):
        """Stop the health check server."""
        if self.site:
            await self.site.stop()
        if self.runner:
            await self.runner.cleanup()
        self.logger.info("✅ Health check server stopped")


class DNSMonitorService:
    """Main service that orchestrates all components."""
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.settings = get_settings()
        self.db_manager = None
        self.dns_monitor = None
        self.discord_bot = None
        self.health_server = HealthCheckServer()
        self._shutdown_event = asyncio.Event()
    
    async def initialize(self):
        """Initialize all service components."""
        self.logger.info("Initializing DNS Monitor Service...")
        
        try:
            # Initialize database
            self.logger.info("🗄️ Initializing database connection...")
            self.db_manager = await get_db_manager()
            await self.db_manager.initialize()
            self.logger.info("✅ Database initialized and schema verified")
            
            # Initialize DNS monitor
            self.logger.info("🔍 Initializing DNS monitoring service...")
            self.dns_monitor = await get_dns_monitor()
            await self.dns_monitor.initialize()
            self.logger.info("✅ DNS Monitor initialized")
            
            # Initialize Discord bot
            self.logger.info("🤖 Initializing Discord bot...")
            self.discord_bot = await get_discord_bot()
            
            # Set the initialized services in the Discord bot
            set_services(self.db_manager, self.dns_monitor)
            self.logger.info("✅ Discord Bot initialized with services")
            
            # DNS monitor notifications can be added later if needed
            
            self.logger.info("🚀 All components initialized successfully")
            
        except Exception as e:
            self.logger.error(f"❌ Failed to initialize service: {e}")
            self.logger.error("💡 Common issues:")
            self.logger.error("   - Check your DATABASE_URL is correct and accessible")
            self.logger.error("   - Ensure the database exists (the schema will be created automatically)")
            self.logger.error("   - Verify Discord bot credentials are valid")
            self.logger.error("   - Check network connectivity to database and Discord")
            raise
    
    # def _connect_dns_to_discord(self):
    #     """Connect DNS monitor notifications to Discord bot."""
    #     # Simplified for now - can be re-enabled later
    #     pass
    
    async def start(self):
        """Start all service components."""
        self.logger.info("Starting DNS Monitor Service...")
        
        try:
            # Start health check server first
            await self.health_server.start()
            
            # Start DNS monitoring
            await self.dns_monitor.start_monitoring()
            self.logger.info("✅ DNS monitoring started")
            
            # Start Discord bot (this will block until the bot stops)
            try:
                bot_task = asyncio.create_task(
                    self.discord_bot.start(self.settings.discord_bot_token)
                )
            except Exception as e:
                self.logger.error(f"❌ Failed to start Discord bot: {e}")
                if "PrivilegedIntentsRequired" in str(e):
                    self.logger.error("💡 Discord bot needs privileged intents enabled:")
                    self.logger.error("   1. Go to https://discord.com/developers/applications/")
                    self.logger.error("   2. Select your application")
                    self.logger.error("   3. Go to 'Bot' section")
                    self.logger.error("   4. Enable 'Message Content Intent' if needed")
                    self.logger.error("   5. Save changes and restart the bot")
                elif "Unauthorized" in str(e):
                    self.logger.error("💡 Check your DISCORD_BOT_TOKEN - it may be invalid")
                raise
            
            # Wait for shutdown signal or bot to stop
            shutdown_task = asyncio.create_task(self._shutdown_event.wait())
            
            self.logger.info("🎯 Service is now running...")
            
            # Wait for either the bot to stop or shutdown signal
            done, pending = await asyncio.wait(
                [bot_task, shutdown_task],
                return_when=asyncio.FIRST_COMPLETED
            )
            
            # Cancel pending tasks
            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            
            self.logger.info("🛑 Service stopping...")
            
        except Exception as e:
            self.logger.error(f"❌ Error running service: {e}")
            raise
    
    async def stop(self):
        """Stop all service components."""
        self.logger.info("Stopping DNS Monitor Service...")
        
        try:
            # Signal shutdown
            self._shutdown_event.set()
            
            # Stop DNS monitoring
            if self.dns_monitor:
                await self.dns_monitor.stop_monitoring()
                await self.dns_monitor.close()
                self.logger.info("✅ DNS Monitor stopped")
            
            # Close Discord bot
            if self.discord_bot and not self.discord_bot.is_closed():
                await self.discord_bot.close()
                self.logger.info("✅ Discord Bot stopped")
            
            # Close database
            if self.db_manager:
                await self.db_manager.close()
                self.logger.info("✅ Database closed")
            
            # Stop health server
            if self.health_server:
                await self.health_server.stop()
            
            self.logger.info("✅ Service stopped successfully")
            
        except Exception as e:
            self.logger.error(f"❌ Error stopping service: {e}")


async def main():
    """Main entry point."""
    # Set up logging
    logger = setup_logging()
    logger.info("🚀 Starting DNS Monitor Bot...")
    
    # Create service
    service = DNSMonitorService()
    
    # Set up signal handlers for graceful shutdown
    def signal_handler(signum, frame):
        logger.info(f"Received signal {signum}, initiating shutdown...")
        asyncio.create_task(service.stop())
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    try:
        # Initialize and start service
        await service.initialize()
        await service.start()
        
    except KeyboardInterrupt:
        logger.info("Received keyboard interrupt, shutting down...")
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        return 1
    finally:
        await service.stop()
    
    logger.info("👋 DNS Monitor Bot shutdown complete")
    return 0


if __name__ == "__main__":
    # Run the service
    try:
        exit_code = asyncio.run(main())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\nShutdown requested by user")
        sys.exit(0)
    except Exception as e:
        print(f"Fatal error: {e}")
        sys.exit(1)
