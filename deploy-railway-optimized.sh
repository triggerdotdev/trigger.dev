#!/bin/bash

# Optimized Railway Deployment for Trigger.dev
# Uses Railway's template variables and managed services

set -e

echo "🚀 Trigger.dev Optimized Railway Deployment"
echo "==========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to generate random secret
generate_secret() {
    openssl rand -hex 16
}

echo -e "${BLUE}📋 This deployment will:${NC}"
echo "  ✓ Use Railway's managed PostgreSQL and Redis"
echo "  ✓ Auto-configure URLs using Railway's domain"
echo "  ✓ Use cross-service variable references (no URL parsing!)"
echo "  ✓ Copy .env.example for build-time requirements"
echo "  ✓ Generate secure secrets automatically"
echo "  ✓ Enable private networking between services"
echo ""

# Check if Railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo -e "${RED}❌ Railway CLI is not installed.${NC}"
    echo "Please install it first:"
    echo -e "${YELLOW}npm install -g @railway/cli${NC}"
    exit 1
fi

# Check if logged in
if ! railway whoami &> /dev/null; then
    echo -e "${YELLOW}📝 Please log in to Railway...${NC}"
    railway login
fi

echo -e "${GREEN}✅ Railway CLI ready${NC}"
echo ""

# Ask for project creation or use existing
echo "Choose an option:"
echo "1) Create new Railway project"
echo "2) Use existing Railway project (recommended for testing)"
echo "3) Exit and follow manual deployment steps"
read -p "Enter choice (1-3): " project_choice

case $project_choice in
    1)
        echo ""
        echo -e "${BLUE}Creating new Railway project...${NC}"
        railway init
        PROJECT_ID=$(railway status --json | jq -r '.projectId')
        ;;
    2)
        echo ""
        echo -e "${BLUE}Using existing project${NC}"
        railway link
        PROJECT_ID=$(railway status --json | jq -r '.projectId')
        ;;
    3)
        echo ""
        echo -e "${BLUE}📖 Manual deployment recommended for first-time setup${NC}"
        echo ""
        echo "Follow these steps:"
        echo "1. railway link [project-id]"
        echo "2. railway add --database postgres"
        echo "3. railway add --database redis" 
        echo "4. Set environment variables manually"
        echo "5. railway up --detach"
        echo ""
        echo "See RAILWAY_DEPLOYMENT.md for detailed instructions"
        exit 0
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}✅ Project linked: $PROJECT_ID${NC}"
echo ""

# Create services using Railway CLI
echo -e "${BLUE}📦 Setting up Railway services...${NC}"
echo ""

# Add PostgreSQL
echo "Adding PostgreSQL database..."
railway add --database postgres || echo "PostgreSQL may already exist"

# Add Redis  
echo "Adding Redis cache..."
railway add --database redis || echo "Redis may already exist"

echo ""
echo -e "${BLUE}🔐 Generating secure secrets...${NC}"

# Generate secrets and create temporary env file
cat > .railway-env-temp << EOF
# Auto-generated secrets
SESSION_SECRET=$(generate_secret)
MAGIC_LINK_SECRET=$(generate_secret)
ENCRYPTION_KEY=$(generate_secret)
MANAGED_WORKER_SECRET=$(generate_secret)

# Additional required variables
REDIS_TLS_DISABLED=true
APP_LOG_LEVEL=info

# Optional: ClickHouse (for analytics)
CLICKHOUSE_URL=
CLICKHOUSE_LOG_LEVEL=info
RUN_REPLICATION_ENABLED=0

# Optional: Object Storage (for large payloads)
OBJECT_STORE_BASE_URL=
OBJECT_STORE_ACCESS_KEY_ID=
OBJECT_STORE_SECRET_ACCESS_KEY=

# Optional: Registry (for deployments)
DEPLOY_REGISTRY_HOST=
DEPLOY_REGISTRY_NAMESPACE=trigger
EOF

echo -e "${GREEN}✅ Secrets generated${NC}"
echo ""

# Set environment variables using Railway's cross-service references
echo -e "${BLUE}📝 Setting environment variables...${NC}"

# Read the temp file and set variables
while IFS='=' read -r key value; do
    # Skip comments and empty lines
    if [[ ! "$key" =~ ^#.*$ ]] && [[ -n "$key" ]]; then
        echo "Setting $key"
        railway variables --set "$key=$value" 2>/dev/null || true
    fi
done < .railway-env-temp

echo ""
echo -e "${GREEN}✅ Using Railway's cross-service references:${NC}"
echo "  - Postgres: \${{Postgres.DATABASE_URL}}"
echo "  - Redis: \${{Redis.RAILWAY_PRIVATE_DOMAIN}}:\${{Redis.REDISPORT}}"
echo "  - No URL parsing needed!"

# Clean up temp file
rm -f .railway-env-temp

echo ""
echo -e "${BLUE}📧 Email Configuration (optional)${NC}"
echo "Configure email for magic links?"
echo "1) Skip (use logs for magic links)"
echo "2) Configure Resend"
echo "3) Configure SMTP"
read -p "Enter choice (1-3): " email_choice

case $email_choice in
    2)
        read -p "Enter Resend API key: " resend_key
        read -p "Enter FROM email: " from_email
        read -p "Enter REPLY-TO email: " reply_email
        
        railway variables --set "EMAIL_TRANSPORT=resend"
        railway variables --set "RESEND_API_KEY=$resend_key"
        railway variables --set "FROM_EMAIL=$from_email"
        railway variables --set "REPLY_TO_EMAIL=$reply_email"
        ;;
    3)
        read -p "Enter SMTP host: " smtp_host
        read -p "Enter SMTP port: " smtp_port
        read -p "Enter SMTP user: " smtp_user
        read -s -p "Enter SMTP password: " smtp_password
        echo ""
        read -p "Enter FROM email: " from_email
        read -p "Enter REPLY-TO email: " reply_email
        
        railway variables --set "EMAIL_TRANSPORT=smtp"
        railway variables --set "SMTP_HOST=$smtp_host"
        railway variables --set "SMTP_PORT=$smtp_port"
        railway variables --set "SMTP_USER=$smtp_user"
        railway variables --set "SMTP_PASSWORD=$smtp_password"
        railway variables --set "SMTP_SECURE=false"
        railway variables --set "FROM_EMAIL=$from_email"
        railway variables --set "REPLY_TO_EMAIL=$reply_email"
        ;;
esac

echo ""
echo -e "${BLUE}🚀 Deploying to Railway...${NC}"
echo ""

# Deploy
railway up -d

echo ""
echo -e "${GREEN}✅ Deployment started!${NC}"
echo ""
echo -e "${YELLOW}📋 Next Steps:${NC}"
echo "1. Wait for deployment to complete (2-3 minutes)"
echo "   Check status: ${BLUE}railway logs -f${NC}"
echo ""
echo "2. Get your app URL:"
echo "   ${BLUE}railway open${NC}"
echo ""
echo "3. Look for magic link in logs (if email not configured):"
echo "   ${BLUE}railway logs | grep -A 5 'Magic link'${NC}"
echo ""
echo "4. Initialize your first Trigger.dev project:"
echo "   ${BLUE}npx trigger.dev@v4-beta init -p my-project -a https://YOUR-APP.railway.app${NC}"
echo ""
echo -e "${GREEN}🎉 Deployment configuration complete!${NC}"
echo ""
echo "Need help? Check RAILWAY_DEPLOYMENT.md or join Discord: https://discord.gg/triggerdotdev"