# DNS Monitor Bot - Python Edition

A user-driven DNS monitoring solution with PostgreSQL and Discord voting system.

## Quick Start
1. cp env.example .env
2. Edit .env with your Discord credentials  
3. docker-compose up --build -d

## Commands
- /add <domain> - Add domain
- /remove <domain> - Remove domain
- /list - List domains
- /status <domain> - Check status

## Voting System
New IPs trigger Discord voting via reactions:
✅ Mark as known (silent logging)
❌ Treat as alert (notifications)

