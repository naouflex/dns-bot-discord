"""Database connection and operations for DNS Monitor Bot."""

import asyncpg
import asyncio
from typing import List, Optional, Dict, Any, Tuple
from datetime import datetime, timedelta
import logging
from contextlib import asynccontextmanager

from .config import get_settings

logger = logging.getLogger(__name__)


class DatabaseManager:
    """Manages PostgreSQL database connections and operations."""
    
    def __init__(self):
        self.settings = get_settings()
        self._pool: Optional[asyncpg.Pool] = None
    
    async def initialize(self):
        """Initialize the database connection pool and create schema if needed."""
        try:
            postgres_config = self.settings.postgres_config
            self._pool = await asyncpg.create_pool(
                host=postgres_config['host'],
                port=postgres_config['port'],
                database=postgres_config['database'],
                user=postgres_config['user'],
                password=postgres_config['password'],
                min_size=2,
                max_size=10,
                command_timeout=30
            )
            logger.info("Database connection pool initialized")
            
            # Test connection and setup schema
            await self._setup_database_schema()
            logger.info("Database initialization completed successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize database: {e}")
            raise
    
    async def close(self):
        """Close the database connection pool."""
        if self._pool:
            await self._pool.close()
            logger.info("Database connection pool closed")
    
    async def _setup_database_schema(self):
        """Set up database schema if it doesn't exist."""
        async with self._pool.acquire() as conn:
            try:
                # Test if the main tables exist
                tables_exist = await conn.fetchval("""
                    SELECT EXISTS (
                        SELECT 1 FROM information_schema.tables 
                        WHERE table_schema = 'public' 
                        AND table_name = 'domains'
                    )
                """)
                
                if not tables_exist:
                    logger.info("Database schema not found, creating tables...")
                    await self._create_database_schema(conn)
                    logger.info("Database schema created successfully")
                else:
                    logger.info("Database schema already exists")
                    
                # Test basic query
                await conn.execute("SELECT 1")
                logger.info("Database connection test successful")
                
            except Exception as e:
                logger.error(f"Failed to setup database schema: {e}")
                raise
    
    async def _create_database_schema(self, conn):
        """Create the database schema."""
        from pathlib import Path
        
        # Read schema file
        schema_file = Path(__file__).parent.parent / "database" / "schema.sql"
        if not schema_file.exists():
            raise FileNotFoundError(f"Schema file not found: {schema_file}")
        
        schema_sql = schema_file.read_text()
        logger.info("Executing database schema creation...")
        
        # Execute schema in a transaction
        async with conn.transaction():
            await conn.execute(schema_sql)
        
        # Read and execute seed data if it exists
        seed_file = Path(__file__).parent.parent / "database" / "seed.sql"
        if seed_file.exists():
            logger.info("Executing seed data...")
            seed_sql = seed_file.read_text()
            async with conn.transaction():
                await conn.execute(seed_sql)
            logger.info("Seed data inserted successfully")
        else:
            logger.info("No seed file found, skipping seed data")
    
    @asynccontextmanager
    async def get_connection(self):
        """Get a database connection from the pool."""
        if not self._pool:
            raise RuntimeError("Database not initialized")
        
        async with self._pool.acquire() as conn:
            yield conn
    
    # Domain operations
    async def add_domain(self, domain: str, is_static: bool = False, added_by: Optional[str] = None) -> int:
        """Add a new domain to monitor."""
        async with self.get_connection() as conn:
            try:
                domain_id = await conn.fetchval(
                    """
                    INSERT INTO domains (domain, is_static, added_by) 
                    VALUES ($1, $2, $3) 
                    RETURNING id
                    """,
                    domain, is_static, added_by
                )
                logger.info(f"Added domain {domain} with ID {domain_id}")
                return domain_id
            except asyncpg.UniqueViolationError:
                # Domain already exists, get its ID
                domain_id = await conn.fetchval(
                    "SELECT id FROM domains WHERE domain = $1", domain
                )
                logger.info(f"Domain {domain} already exists with ID {domain_id}")
                return domain_id
    
    async def remove_domain(self, domain: str) -> bool:
        """Remove a domain from monitoring."""
        async with self.get_connection() as conn:
            result = await conn.execute(
                "UPDATE domains SET is_active = FALSE WHERE domain = $1",
                domain
            )
            removed = result.split()[-1] == '1'  # Check if one row was affected
            if removed:
                logger.info(f"Removed domain {domain}")
            return removed
    
    async def get_active_domains(self) -> List[Dict[str, Any]]:
        """Get all active domains."""
        async with self.get_connection() as conn:
            rows = await conn.fetch(
                """
                SELECT id, domain, is_static, added_by, added_at 
                FROM domains 
                WHERE is_active = TRUE 
                ORDER BY domain
                """
            )
            return [dict(row) for row in rows]
    
    async def get_domain_by_name(self, domain: str) -> Optional[Dict[str, Any]]:
        """Get domain information by name."""
        async with self.get_connection() as conn:
            row = await conn.fetchrow(
                "SELECT id, domain, is_static, added_by, added_at FROM domains WHERE domain = $1",
                domain
            )
            return dict(row) if row else None
    
    # DNS records operations
    async def add_dns_record(self, domain_id: int, ip_addresses: List[str], 
                           ttl: Optional[int] = None, dns_status: Optional[int] = None,
                           soa_serial: Optional[str] = None, nameserver: Optional[str] = None,
                           admin_email: Optional[str] = None, change_detected: bool = False,
                           change_type: Optional[str] = None, previous_ips: Optional[List[str]] = None) -> int:
        """Add a DNS record entry."""
        async with self.get_connection() as conn:
            record_id = await conn.fetchval(
                """
                INSERT INTO dns_records 
                (domain_id, ip_addresses, ttl, dns_status, soa_serial, nameserver, 
                 admin_email, change_detected, change_type, previous_ips)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING id
                """,
                domain_id, ip_addresses, ttl, dns_status, soa_serial, 
                nameserver, admin_email, change_detected, change_type, previous_ips
            )
            return record_id
    
    async def get_latest_dns_record(self, domain_id: int) -> Optional[Dict[str, Any]]:
        """Get the most recent DNS record for a domain."""
        async with self.get_connection() as conn:
            row = await conn.fetchrow(
                """
                SELECT id, domain_id, ip_addresses, ttl, dns_status, soa_serial,
                       nameserver, admin_email, checked_at, change_detected, 
                       change_type, previous_ips
                FROM dns_records 
                WHERE domain_id = $1 
                ORDER BY checked_at DESC 
                LIMIT 1
                """,
                domain_id
            )
            return dict(row) if row else None
    
    # Known addresses operations
    async def add_known_address(self, domain_id: int, ip_address: str, 
                              added_by_user_id: str, vote_message_id: Optional[str] = None) -> int:
        """Add a known address for a domain."""
        async with self.get_connection() as conn:
            try:
                addr_id = await conn.fetchval(
                    """
                    INSERT INTO known_addresses 
                    (domain_id, ip_address, added_by_user_id, vote_message_id, is_confirmed)
                    VALUES ($1, $2, $3, $4, TRUE)
                    RETURNING id
                    """,
                    domain_id, ip_address, added_by_user_id, vote_message_id
                )
                return addr_id
            except asyncpg.UniqueViolationError:
                # Address already exists for this domain
                return await conn.fetchval(
                    "SELECT id FROM known_addresses WHERE domain_id = $1 AND ip_address = $2",
                    domain_id, ip_address
                )
    
    async def is_known_address(self, domain_id: int, ip_address: str) -> bool:
        """Check if an IP address is known for a domain."""
        async with self.get_connection() as conn:
            result = await conn.fetchval(
                """
                SELECT EXISTS(
                    SELECT 1 FROM known_addresses 
                    WHERE domain_id = $1 AND ip_address = $2 AND is_confirmed = TRUE
                )
                """,
                domain_id, ip_address
            )
            return result
    
    async def get_known_addresses(self, domain_id: int) -> List[str]:
        """Get all confirmed known addresses for a domain."""
        async with self.get_connection() as conn:
            rows = await conn.fetch(
                """
                SELECT ip_address FROM known_addresses 
                WHERE domain_id = $1 AND is_confirmed = TRUE
                ORDER BY added_at
                """,
                domain_id
            )
            return [row['ip_address'] for row in rows]
    
    # Voting operations
    async def create_vote_session(self, domain_id: int, ip_address: str, 
                                discord_message_id: str) -> int:
        """Create a new voting session for an IP address."""
        async with self.get_connection() as conn:
            vote_id = await conn.fetchval(
                """
                INSERT INTO address_votes (domain_id, ip_address, discord_message_id)
                VALUES ($1, $2, $3)
                RETURNING id
                """,
                domain_id, ip_address, discord_message_id
            )
            return vote_id
    
    async def add_user_vote(self, vote_session_id: int, user_id: str, vote: bool) -> bool:
        """Add or update a user's vote."""
        async with self.get_connection() as conn:
            try:
                await conn.execute(
                    """
                    INSERT INTO user_votes (vote_session_id, user_id, vote)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (vote_session_id, user_id) 
                    DO UPDATE SET vote = EXCLUDED.vote, voted_at = NOW()
                    """,
                    vote_session_id, user_id, vote
                )
                
                # Update vote counts in address_votes
                await conn.execute(
                    """
                    UPDATE address_votes SET
                        total_votes = (SELECT COUNT(*) FROM user_votes WHERE vote_session_id = $1),
                        confirmed_votes = (SELECT COUNT(*) FROM user_votes WHERE vote_session_id = $1 AND vote = TRUE),
                        rejected_votes = (SELECT COUNT(*) FROM user_votes WHERE vote_session_id = $1 AND vote = FALSE)
                    WHERE id = $1
                    """,
                    vote_session_id
                )
                return True
            except Exception as e:
                logger.error(f"Error adding user vote: {e}")
                return False
    
    async def get_vote_session_by_message_id(self, discord_message_id: str) -> Optional[Dict[str, Any]]:
        """Get vote session by Discord message ID."""
        async with self.get_connection() as conn:
            row = await conn.fetchrow(
                """
                SELECT av.*, d.domain 
                FROM address_votes av
                JOIN domains d ON d.id = av.domain_id
                WHERE av.discord_message_id = $1
                """,
                discord_message_id
            )
            return dict(row) if row else None
    
    async def resolve_vote_session(self, vote_session_id: int, final_decision: bool) -> bool:
        """Resolve a voting session and optionally add to known addresses."""
        async with self.get_connection() as conn:
            async with conn.transaction():
                # Mark session as resolved
                await conn.execute(
                    """
                    UPDATE address_votes 
                    SET is_resolved = TRUE, final_decision = $2
                    WHERE id = $1
                    """,
                    vote_session_id, final_decision
                )
                
                # If decision is to add to known addresses, do it
                if final_decision:
                    vote_info = await conn.fetchrow(
                        "SELECT domain_id, ip_address, discord_message_id FROM address_votes WHERE id = $1",
                        vote_session_id
                    )
                    if vote_info:
                        try:
                            await conn.execute(
                                """
                                INSERT INTO known_addresses 
                                (domain_id, ip_address, added_by_user_id, vote_message_id, is_confirmed)
                                VALUES ($1, $2, 'vote_system', $3, TRUE)
                                ON CONFLICT (domain_id, ip_address) DO NOTHING
                                """,
                                vote_info['domain_id'], vote_info['ip_address'], vote_info['discord_message_id']
                            )
                        except Exception as e:
                            logger.error(f"Error adding to known addresses: {e}")
                
                return True
    
    async def cleanup_expired_votes(self):
        """Clean up expired voting sessions."""
        async with self.get_connection() as conn:
            await conn.execute("SELECT cleanup_expired_votes()")
    
    # Notification operations
    async def add_notification(self, domain_id: Optional[int], notification_type: str,
                             title: str, content: Optional[str] = None,
                             discord_message_id: Optional[str] = None,
                             requires_user_action: bool = False) -> int:
        """Add a notification record."""
        async with self.get_connection() as conn:
            notif_id = await conn.fetchval(
                """
                INSERT INTO notifications 
                (domain_id, notification_type, title, content, discord_message_id, requires_user_action)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id
                """,
                domain_id, notification_type, title, content, discord_message_id, requires_user_action
            )
            return notif_id
    
    # System configuration operations
    async def get_config(self, key: str, default: Optional[str] = None) -> Optional[str]:
        """Get a system configuration value."""
        async with self.get_connection() as conn:
            result = await conn.fetchval(
                "SELECT get_config($1, $2)",
                key, default
            )
            return result
    
    async def set_config(self, key: str, value: str, description: Optional[str] = None):
        """Set a system configuration value."""
        async with self.get_connection() as conn:
            await conn.execute(
                "SELECT set_config($1, $2, $3)",
                key, value, description
            )


# Global database manager instance
db_manager = DatabaseManager()


async def get_db_manager() -> DatabaseManager:
    """Get the global database manager instance."""
    return db_manager
