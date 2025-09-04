#!/bin/bash

# DNS Monitor Bot Startup Script

echo "🚀 Starting DNS Monitor Bot..."

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "❌ .env file not found!"
    echo "📝 Please copy env.example to .env and configure it:"
    echo "   cp env.example .env"
    echo "   # Edit .env with your Discord credentials"
    exit 1
fi

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker is not running!"
    echo "🐳 Please start Docker and try again"
    exit 1
fi

# Build and start services
echo "🔨 Building and starting services..."
docker-compose up --build -d

# Wait a moment for services to start
sleep 5

# Check service status
echo "📊 Service Status:"
docker-compose ps

echo ""
echo "✅ DNS Monitor Bot is starting up!"
echo ""
echo "📋 Useful commands:"
echo "  docker-compose logs -f dns_monitor  # View logs"
echo "  docker-compose ps                   # Check status"
echo "  docker-compose down                 # Stop services"
echo ""
echo "🤖 Your Discord bot should now be online!"
echo "   Try the /help command in Discord"
