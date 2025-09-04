#!/usr/bin/env python3
"""
Database setup script for DNS Monitor Bot.
Run this script to create the database schema on your PostgreSQL instance.
"""

import asyncio
import asyncpg
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from src.config import get_settings


async def setup_database():
    """Set up the database schema."""
    print("🗄️ Setting up DNS Monitor database...")
    
    try:
        settings = get_settings()
        postgres_config = settings.postgres_config
        
        print(f"Connecting to PostgreSQL at {postgres_config['host']}:{postgres_config['port']}")
        
        # Connect to PostgreSQL
        conn = await asyncpg.connect(
            host=postgres_config['host'],
            port=postgres_config['port'],
            database=postgres_config['database'],
            user=postgres_config['user'],
            password=postgres_config['password']
        )
        
        print("✅ Connected to database")
        
        # Read and execute schema
        schema_file = Path(__file__).parent / "database" / "schema.sql"
        if not schema_file.exists():
            print("❌ Schema file not found: database/schema.sql")
            return False
        
        print("📋 Executing schema...")
        schema_sql = schema_file.read_text()
        await conn.execute(schema_sql)
        print("✅ Schema created successfully")
        
        # Read and execute seed data
        seed_file = Path(__file__).parent / "database" / "seed.sql"
        if seed_file.exists():
            print("🌱 Executing seed data...")
            seed_sql = seed_file.read_text()
            await conn.execute(seed_sql)
            print("✅ Seed data inserted successfully")
        else:
            print("ℹ️ No seed file found, skipping seed data")
        
        # Test the setup
        print("🧪 Testing database setup...")
        
        # Check if tables exist
        tables = await conn.fetch("""
            SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public' 
            ORDER BY tablename
        """)
        
        table_names = [row['tablename'] for row in tables]
        expected_tables = [
            'domains', 'dns_records', 'known_addresses', 
            'address_votes', 'user_votes', 'notifications', 'system_config'
        ]
        
        missing_tables = [t for t in expected_tables if t not in table_names]
        if missing_tables:
            print(f"⚠️ Missing tables: {missing_tables}")
        else:
            print("✅ All required tables created")
        
        print(f"📊 Created tables: {', '.join(table_names)}")
        
        # Test configuration functions
        test_config = await conn.fetchval("SELECT get_config('bot_version', 'unknown')")
        print(f"🔧 Configuration test: bot_version = {test_config}")
        
        await conn.close()
        print("🎉 Database setup completed successfully!")
        return True
        
    except Exception as e:
        print(f"❌ Database setup failed: {e}")
        return False


async def check_database():
    """Check if database is accessible and properly configured."""
    print("🔍 Checking database connection...")
    
    try:
        settings = get_settings()
        postgres_config = settings.postgres_config
        
        conn = await asyncpg.connect(
            host=postgres_config['host'],
            port=postgres_config['port'],
            database=postgres_config['database'],
            user=postgres_config['user'],
            password=postgres_config['password']
        )
        
        # Test basic query
        result = await conn.fetchval("SELECT 1")
        if result == 1:
            print("✅ Database connection successful")
        
        # Check tables
        tables = await conn.fetch("""
            SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public' 
            ORDER BY tablename
        """)
        
        if tables:
            print(f"📋 Found tables: {', '.join([row['tablename'] for row in tables])}")
        else:
            print("⚠️ No tables found - you may need to run setup")
        
        await conn.close()
        return True
        
    except Exception as e:
        print(f"❌ Database check failed: {e}")
        print("💡 Make sure your DATABASE_URL is correct and the database is running")
        return False


def print_usage():
    """Print usage information."""
    print("""
🗄️ DNS Monitor Database Setup

Usage:
    python setup_database.py [command]

Commands:
    setup    - Create database schema and seed data
    check    - Check database connection and tables
    help     - Show this help message

Examples:
    python setup_database.py setup
    python setup_database.py check

Make sure to:
1. Set your DATABASE_URL in the .env file
2. Ensure your PostgreSQL instance is running
3. Create the database if it doesn't exist
""")


async def main():
    """Main function."""
    if len(sys.argv) < 2:
        command = "help"
    else:
        command = sys.argv[1].lower()
    
    if command == "setup":
        success = await setup_database()
        sys.exit(0 if success else 1)
    elif command == "check":
        success = await check_database()
        sys.exit(0 if success else 1)
    elif command == "help":
        print_usage()
        sys.exit(0)
    else:
        print(f"❌ Unknown command: {command}")
        print_usage()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
