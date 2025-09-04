"""Configuration management for DNS Monitor Bot."""

import os
from typing import List, Optional
from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Database Configuration
    database_url: str = Field(..., description="PostgreSQL connection URL", alias="DATABASE_URL")
    
    # Discord Configuration
    discord_bot_token: str = Field(..., description="Discord bot token", alias="DISCORD_BOT_TOKEN")
    discord_public_key: str = Field(..., description="Discord public key for verification", alias="DISCORD_PUBLIC_KEY")
    discord_application_id: str = Field(..., description="Discord application ID", alias="DISCORD_APPLICATION_ID")
    discord_webhook_url: str = Field(..., description="Discord webhook URL for notifications", alias="DISCORD_WEBHOOK_URL")
    discord_role_id: Optional[str] = Field(None, description="Discord role ID to mention in alerts", alias="DISCORD_ROLE_ID")
    discord_guild_id: Optional[str] = Field(None, description="Discord guild ID for reference (commands are synced globally)", alias="DISCORD_GUILD_ID")
    
    # DNS Configuration
    dns_resolvers: str = Field(
        default="1.1.1.1,8.8.8.8,9.9.9.9",
        description="Comma-separated list of DNS resolvers to use",
        alias="DNS_RESOLVERS"
    )
    dns_timeout: int = Field(default=5, description="DNS query timeout in seconds", alias="DNS_TIMEOUT")
    
    # Service Configuration
    check_interval_seconds: int = Field(default=60, description="DNS check interval in seconds", alias="CHECK_INTERVAL_SECONDS")
    log_level: str = Field(default="INFO", description="Logging level", alias="LOG_LEVEL")
    
    # User Voting Configuration
    vote_timeout_hours: int = Field(default=24, description="Voting session timeout in hours", alias="VOTE_TIMEOUT_HOURS")
    min_votes_required: int = Field(default=2, description="Minimum votes required to resolve", alias="MIN_VOTES_REQUIRED")
    majority_threshold: float = Field(default=0.6, description="Majority threshold (0.0-1.0)", alias="MAJORITY_THRESHOLD")
    
    model_config = {
        'env_file': '.env',
        'env_file_encoding': 'utf-8',
        'case_sensitive': False,
    }
    
    @property
    def dns_resolvers_list(self) -> List[str]:
        """Get DNS resolvers as a list."""
        return [r.strip() for r in self.dns_resolvers.split(',')]
    
    @property
    def postgres_config(self) -> dict:
        """Extract PostgreSQL connection parameters from database_url."""
        from urllib.parse import urlparse
        
        # Parse the database URL properly
        parsed = urlparse(self.database_url)
        
        if parsed.scheme not in ('postgresql', 'postgres'):
            raise ValueError("DATABASE_URL must start with postgresql:// or postgres://")
        
        return {
            'host': parsed.hostname or 'localhost',
            'port': parsed.port or 5432,
            'database': parsed.path.lstrip('/') if parsed.path else 'dns_monitor',
            'user': parsed.username or '',
            'password': parsed.password or ''
        }


# Global settings instance
settings = Settings()


def get_settings() -> Settings:
    """Get the global settings instance."""
    return settings
