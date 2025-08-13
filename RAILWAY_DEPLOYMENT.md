# Deploy Trigger.dev to Railway

This guide explains how to deploy Trigger.dev on Railway with **zero configuration** using Railway's cross-service variable references and managed services.

## ⚡ Quick Reference

**Essential Railway Commands:**
```bash
# Link to project
railway link [project-id]

# Add databases (correct syntax!)
railway add --database postgres
railway add --database redis  

# Set environment variables
railway variables --set SESSION_SECRET=$(openssl rand -hex 16)

# Deploy
railway up --detach

# Monitor
railway logs -f
railway status
```

## 🚀 Quick Deploy

### Option 1: Automated Script (Recommended)

```bash
./deploy-railway-optimized.sh
```

This script will:
- Create a Railway project with PostgreSQL and Redis
- Auto-configure all URLs using Railway's domain
- Set up cross-service variable references
- Generate secure secrets automatically
- Deploy your application with zero manual configuration

### Option 2: One-Click Template

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/triggerdotdev/trigger.dev)

Railway will automatically:
- Provision PostgreSQL and Redis with private networking
- Configure all environment variables using cross-service references
- Set up public domain with HTTPS
- Deploy the application with zero configuration

### Option 3: Manual Deploy from Source

1. Fork or clone this repository
2. Push to your GitHub repository
3. Create a new project on Railway
4. Add PostgreSQL and Redis services
5. Connect your GitHub repository
6. Railway will auto-detect the configuration and deploy

## 🛠️ Manual Deployment Steps (Step-by-Step)

For testing or when you want full control over the deployment process:

### Step 1: Link to Your Railway Project
```bash
# Link to existing project (replace with your project ID)
railway link 2aaaccd4-f232-4a6a-9634-f73689d675eb

# Verify you're connected to the right project
railway status
```

### Step 2: Add Required Database Services
```bash
# Add PostgreSQL database service
railway add --database postgres

# Add Redis cache service  
railway add --database redis

# Verify services were created
railway status
```

You should see output similar to:
```
Project: your-project-name
Environment: production
Services:
  - PostgreSQL (database)
  - Redis (database)
```

### Step 3: Generate and Set Environment Variables
```bash
# Generate required secrets
SESSION_SECRET=$(openssl rand -hex 16)
MAGIC_LINK_SECRET=$(openssl rand -hex 16)
ENCRYPTION_KEY=$(openssl rand -hex 16)
MANAGED_WORKER_SECRET=$(openssl rand -hex 16)

# Set the secrets in Railway
railway variables --set SESSION_SECRET=$SESSION_SECRET
railway variables --set MAGIC_LINK_SECRET=$MAGIC_LINK_SECRET
railway variables --set ENCRYPTION_KEY=$ENCRYPTION_KEY
railway variables --set MANAGED_WORKER_SECRET=$MANAGED_WORKER_SECRET

# Set Redis configuration
railway variables --set REDIS_TLS_DISABLED=true

# Verify variables are set
railway variables
```

### Step 4: Deploy from Branch (Testing)
```bash
# Create and push feature branch for testing
git checkout -b railway-deployment-test
git add railway.json nixpacks.toml .env.railway RAILWAY_DEPLOYMENT.md railway-template.json
git commit -m "Add Railway deployment configuration"
git push origin railway-deployment-test

# Deploy from branch
railway up --detach

# Monitor deployment logs
railway logs -f
```

### Step 5: Verify Deployment
```bash
# Check all services are running
railway status

# Get your application URL
railway open --print-url

# Test health endpoint
curl $(railway open --print-url)/healthcheck

# Check for magic link in logs (if no email configured)
railway logs | grep -i "magic"
```

### Step 6: Production Deploy (After Testing)
```bash
# Merge to main branch
git checkout main
git merge railway-deployment-test
git push origin main

# Deploy production
railway up --detach
```

## 📋 Prerequisites

- Railway account
- GitHub account (for source deployment)
- (Optional) Email service credentials for magic links

## ⚙️ Build Process

Railway uses a two-phase deployment process that requires special handling for environment variables:

### Build vs Runtime Environment Variables

**Build Phase:**
- Railway only provides basic build environment variables
- Prisma needs `DATABASE_URL` and `DIRECT_URL` to generate the client
- Solution: Copy `.env.example` to `.env` during build to provide placeholders

**Runtime Phase:**  
- Railway provides full environment variables (cross-service references)
- Node.js automatically uses Railway's environment variables over `.env` file
- Real database credentials override placeholders seamlessly

### Build Command Sequence
```bash
cp .env.example .env                    # Provide build-time placeholders
pnpm install --frozen-lockfile         # Install dependencies  
pnpm run generate                       # Generate Prisma client (uses placeholders)
pnpm run build --filter=webapp         # Build application
```

**At Runtime:**
- Railway's `${{Postgres.DATABASE_URL}}` overrides the placeholder
- Railway's `${{Redis.RAILWAY_PRIVATE_DOMAIN}}` provides real Redis host
- No secrets from `.env` are used in production

## 🏗️ Architecture Overview

This Railway deployment uses a **simplified, cloud-native architecture**:

### 🚀 **What Railway Provides:**
- **Webapp Service** - Single Node.js application (built with Nixpacks)
- **Managed PostgreSQL** - Fully managed database with automatic backups
- **Managed Redis** - Fully managed cache with persistence
- **Private Networking** - Internal service-to-service communication
- **Automatic Scaling** - Resource allocation based on demand
- **HTTPS & CDN** - Automatic SSL certificates and global CDN

### 🔄 **vs. Traditional Self-Hosting:**
| Feature | Railway Deployment | Docker Self-Hosting |
|---------|-------------------|---------------------|
| **Setup Complexity** | Zero config | Manual Docker Compose |
| **Database Management** | Managed by Railway | Manual PostgreSQL container |
| **Redis Management** | Managed by Railway | Manual Redis container |
| **Service Discovery** | Cross-service references | Manual networking |
| **Scaling** | Automatic | Manual container scaling |
| **Monitoring** | Built-in Railway dashboard | Manual setup required |
| **Backups** | Automatic | Manual configuration |

### 🎯 **What's NOT Included:**
- **ClickHouse** - Optional analytics (can be added separately)
- **MinIO/Object Storage** - Uses Railway's file storage instead
- **Worker Containers** - Tasks run within the main webapp process
- **Docker Registry** - Uses Railway's built-in deployment system

## 🔧 Configuration

### Automatic Configuration

Railway automatically configures these using template variables and cross-service references:

**URLs:**
- `APP_ORIGIN`, `LOGIN_ORIGIN`, `API_ORIGIN` - Uses `https://${{RAILWAY_PUBLIC_DOMAIN}}`
- `PORT` - Provided by Railway

**Database:**
- `DATABASE_URL` - Uses `${{Postgres.DATABASE_URL}}`
- `DIRECT_URL` - Uses `${{Postgres.DATABASE_URL}}`

**Redis:**
- `REDIS_HOST` - Uses `${{Redis.RAILWAY_PRIVATE_DOMAIN}}`
- `REDIS_PORT` - Uses `${{Redis.REDISPORT}}`
- `REDIS_PASSWORD` - Uses `${{Redis.REDISPASSWORD}}`

> 🚀 **No URL parsing needed!** Cross-service references handle everything automatically.

### Auto-Generated Secrets

These are generated automatically on deployment:

- `SESSION_SECRET` - Session encryption
- `MAGIC_LINK_SECRET` - Magic link authentication
- `ENCRYPTION_KEY` - Data encryption
- `MANAGED_WORKER_SECRET` - Worker authentication

### Optional: Email Configuration

To enable email-based magic links, configure one of these:

#### Resend
```env
EMAIL_TRANSPORT=resend
FROM_EMAIL=noreply@yourdomain.com
REPLY_TO_EMAIL=support@yourdomain.com
RESEND_API_KEY=your_resend_api_key
```

#### SMTP (Gmail, etc.)
```env
EMAIL_TRANSPORT=smtp
FROM_EMAIL=noreply@yourdomain.com
REPLY_TO_EMAIL=support@yourdomain.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_email@gmail.com
SMTP_PASSWORD=your_app_password
```

### Optional: GitHub OAuth

To enable GitHub login:
```env
AUTH_GITHUB_CLIENT_ID=your_github_client_id
AUTH_GITHUB_CLIENT_SECRET=your_github_client_secret
```

Callback URL: `https://your-railway-domain.railway.app/auth/github/callback`

### Optional: Access Control

Restrict access by email pattern:
```env
WHITELISTED_EMAILS=.*@yourcompany\.com
```

## 🌐 Cross-Service Benefits

Railway's cross-service variable references provide several advantages:

### ✅ **Zero Configuration**
- **No custom entrypoint scripts** - Direct `pnpm start` command
- **No URL parsing logic** - Railway handles all service discovery
- **No manual environment setup** - Cross-service references do everything
- **No Docker Compose complexity** - Single Railway service deployment

### ✅ **Private Networking**
- Uses Railway's internal networking (`RAILWAY_PRIVATE_DOMAIN`)
- **No egress costs** for service-to-service communication
- **Better security** with internal-only connections
- **Automatic service discovery** between PostgreSQL, Redis, and webapp

### ✅ **Simplified Architecture**
- **Single webapp service** - No complex multi-container setup
- **Managed databases** - Railway handles PostgreSQL and Redis
- **Automatic scaling** - Railway manages resource allocation
- **Clear service dependencies** - Cross-service references make relationships explicit

### ✅ **Example References**
```bash
# Direct service references (Railway handles these automatically)
DATABASE_URL=${{Postgres.DATABASE_URL}}        # Note: 'Postgres' not 'PostgreSQL'
REDIS_HOST=${{Redis.RAILWAY_PRIVATE_DOMAIN}}
REDIS_PORT=${{Redis.REDISPORT}}
APP_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
```

## 🔧 How railway.json Actually Works

### Understanding railway.json
**Key Insight: railway.json is a TEMPLATE, not a variable creator**

```json
{
  "environments": {
    "production": {
      "deploy": {
        "SESSION_SECRET": "${{SESSION_SECRET}}",     // Looks for existing variable
        "DATABASE_URL": "${{Postgres.DATABASE_URL}}"   // Railway auto-provides this
      }
    }
  }
}
```

### What railway.json Does ✅
- Defines build/deploy configuration
- Creates variable mapping template
- Resolves Railway template variables at deployment
- Tells Railway "set these environment variables to these values"

### What railway.json Does NOT Do ❌
- Create environment variables on services
- Generate secrets automatically
- Set up cross-service connections
- Work with invalid `${{shared.*}}` syntax

### Two Types of Variables

**1. Railway Auto-Provided (Work automatically) ✅**
```bash
${{PORT}}                           # Railway-provided port
${{Postgres.DATABASE_URL}}          # From PostgreSQL service
${{Redis.RAILWAY_PRIVATE_DOMAIN}}   # From Redis service
${{RAILWAY_PUBLIC_DOMAIN}}          # Service's public domain
```

**2. Service Variables (Must set manually) ⚠️**
```bash
${{SESSION_SECRET}}                 # Must set: railway variables --set SESSION_SECRET=...
${{MAGIC_LINK_SECRET}}             # Must set: railway variables --set MAGIC_LINK_SECRET=...
${{ENCRYPTION_KEY}}                # Must set: railway variables --set ENCRYPTION_KEY=...
```

### Deployment Flow
1. Railway reads `railway.json`: "This service needs SESSION_SECRET"
2. Railway checks service variables: "Does SESSION_SECRET exist?"
3. **If exists**: Uses value and deploys ✅
4. **If missing**: Deployment fails with missing variable error ❌

### Common railway.json Mistakes
```json
// ❌ WRONG - Invalid shared syntax (breaks parsing)
"SESSION_SECRET": "${{shared.SESSION_SECRET}}"

// ✅ CORRECT - Direct variable reference
"SESSION_SECRET": "${{SESSION_SECRET}}"

// ❌ WRONG - Incorrect service name
"DATABASE_URL": "${{PostgreSQL.DATABASE_URL}}"

// ✅ CORRECT - Exact service name (case-sensitive)
"DATABASE_URL": "${{Postgres.DATABASE_URL}}"
```

## 🎯 Post-Deployment Steps

### 1. Access Your Instance

Your app is automatically available at the Railway-provided domain. No manual URL configuration needed!

```bash
railway open  # Opens your app in the browser
```

### 2. Get Your Magic Link

If email is not configured, check the logs for the magic link:

```bash
railway logs | grep -A 5 "Magic link"
```

Or view in Railway dashboard:
- Click on your service
- Go to "Logs" tab
- Search for "magic link"

### 3. Initialize Your First Project

The app URL is automatically configured. Just run:

```bash
# Get your app URL automatically
RAILWAY_URL=$(railway status --json | jq -r '.deployments[0].url')

# Initialize project with your Railway URL
npx trigger.dev@v4-beta init -p my-project -a $RAILWAY_URL

# Or manually get the URL
railway open --print-url
```

### 4. Deploy Your First Task

Create a simple task:

```typescript
// src/trigger/hello.ts
import { task } from "@trigger.dev/sdk/v3";

export const helloWorld = task({
  id: "hello-world",
  run: async (payload: { message: string }) => {
    console.log(payload.message);
    return { success: true };
  },
});
```

Deploy it:
```bash
npx trigger.dev@v4-beta deploy
```

## 🚨 Complete Troubleshooting Guide

### Step-by-Step Deployment Failure Resolution

**1. Check Deployment Status**
```bash
railway status --json | jq '.services.edges[] | {name: .node.name, status: .node.serviceInstances.edges[0].node.latestDeployment.status}'
```

**2. Verify Service Context**
```bash
railway status  # Ensure you're on the webapp service, not Redis/Postgres
```

**3. Generate Missing Components**
```bash
# Generate public domain if missing
railway domain

# Check if domain was created
railway variables | grep RAILWAY_PUBLIC_DOMAIN
```

**4. Set Required Environment Variables**
```bash
# Generate and set secrets (if missing)
railway variables --set "SESSION_SECRET=$(openssl rand -hex 16)"
railway variables --set "MAGIC_LINK_SECRET=$(openssl rand -hex 16)"
railway variables --set "ENCRYPTION_KEY=$(openssl rand -hex 16)"
railway variables --set "MANAGED_WORKER_SECRET=$(openssl rand -hex 16)"

# Set application configuration
railway variables --set "PORT=3030"                    # Critical for Remix apps
railway variables --set "NODE_ENV=production"
railway variables --set "APP_LOG_LEVEL=info"
railway variables --set "REDIS_TLS_DISABLED=true"

# Set database connections (using Railway templates)
railway variables --set "DATABASE_URL=\${{Postgres.DATABASE_URL}}"
railway variables --set "DIRECT_URL=\${{Postgres.DATABASE_URL}}"
railway variables --set "REDIS_HOST=\${{Redis.RAILWAY_PRIVATE_DOMAIN}}"
railway variables --set "REDIS_PORT=\${{Redis.REDISPORT}}"
railway variables --set "REDIS_PASSWORD=\${{Redis.REDISPASSWORD}}"

# Set origin URLs (using Railway domain)
railway variables --set "APP_ORIGIN=https://\${{RAILWAY_PUBLIC_DOMAIN}}"
railway variables --set "LOGIN_ORIGIN=https://\${{RAILWAY_PUBLIC_DOMAIN}}"
railway variables --set "API_ORIGIN=https://\${{RAILWAY_PUBLIC_DOMAIN}}"

# Handle ClickHouse validation (v4-beta)
railway variables --set "CLICKHOUSE_URL="              # Empty to bypass, or real URL
```

**5. Verify Variable Configuration**
```bash
# Check all variables are set
railway variables | grep -E "(SESSION_SECRET|DATABASE_URL|REDIS_HOST|PORT|APP_ORIGIN)"

# Verify count (should have ~20 variables)
railway variables | grep -c "│"
```

**6. Deploy and Monitor**
```bash
# Deploy with monitoring
railway up --detach

# Wait 30 seconds then check status
sleep 30 && railway status --json | jq '.services.edges[] | select(.node.name == "Trigger.dev") | .node.serviceInstances.edges[0].node.latestDeployment.status'
```

**7. Access Build Logs**
If deployment fails, check Railway dashboard using the Build Logs URL from `railway up` output.

### Quick Fix Commands

**Fix PORT Error:**
```bash
railway variables --set "PORT=3030"
railway up --detach
```

**Fix Missing Variables:**
```bash
railway variables --set "SESSION_SECRET=$(openssl rand -hex 16)" \
                  --set "MAGIC_LINK_SECRET=$(openssl rand -hex 16)" \
                  --set "ENCRYPTION_KEY=$(openssl rand -hex 16)" \
                  --set "MANAGED_WORKER_SECRET=$(openssl rand -hex 16)"
```

**Fix ClickHouse Validation:**
```bash
# For testing (disable ClickHouse)
railway variables --set "CLICKHOUSE_URL="

# For production (use ClickHouse Cloud)
railway variables --set "CLICKHOUSE_URL=https://user:password@host.clickhouse.cloud:8443"
```

**Fix Service Context:**
```bash
# If deploying to wrong service
railway service "Trigger.dev"  # Switch to webapp service
railway up --detach
```

## 🔍 Monitoring & Troubleshooting

### View Logs

In Railway dashboard:
1. Select your service
2. Click "View Logs"
3. Filter by service if needed

### Common Issues

#### Magic links not arriving
- **Check email configuration** - Verify EMAIL_TRANSPORT and credentials
- **View webapp logs** for the magic link: `railway logs | grep -i "magic"`
- **Ensure FROM_EMAIL is verified** with your email provider

#### Database connection issues
- **Check Railway PostgreSQL service** - Ensure it's running in Railway dashboard
- **Verify cross-service references** - `${{PostgreSQL.DATABASE_URL}}` should be auto-populated
- **Check service dependencies** - Webapp should be connected to PostgreSQL service

#### Service startup issues
- **Check build logs** - `railway logs --build` to see compilation issues
- **Verify environment variables** - Check cross-service references are properly set
- **Check service health** - All services (webapp, PostgreSQL, Redis) should show as healthy

#### Build failures
- **"IO error for .env file"** - This is expected; the build process copies `.env.example` to `.env` automatically
- **"DATABASE_URL not found during generate"** - Ensure build command includes `cp .env.example .env` before `pnpm run generate`
- **Prisma generate fails** - Check that `.env.example` contains valid placeholder values for `DATABASE_URL` and `DIRECT_URL`

#### Railway CLI issues
- **`railway add postgresql` fails** - Use correct syntax: `railway add --database postgres`
- **`railway add redis` fails** - Use correct syntax: `railway add --database redis`  
- **Services not appearing after add** - Run `railway status` to verify, may need to refresh
- **"Service: None" after linking** - This is normal before adding services

#### Railway-specific issues  
- **Service references not working** - Ensure services are named correctly (`Postgres`, `Redis` - case sensitive)
- **Private domain resolution** - Check that `RAILWAY_PRIVATE_DOMAIN` variables are available
- **Cross-service variables not populating** - Verify service names match exactly (case-sensitive)
- **railway.json not applying variables** - Variables must exist before railway.json can reference them

#### Environment Variable Issues
- **"PORT must be integer between 0 and 65535"** - Set `PORT=3030` explicitly for Remix apps:
  ```bash
  railway variables --set "PORT=3030"
  ```
- **Missing SESSION_SECRET, MAGIC_LINK_SECRET, etc.** - These must be set manually:
  ```bash
  railway variables --set "SESSION_SECRET=$(openssl rand -hex 16)"
  railway variables --set "MAGIC_LINK_SECRET=$(openssl rand -hex 16)"
  railway variables --set "ENCRYPTION_KEY=$(openssl rand -hex 16)"
  railway variables --set "MANAGED_WORKER_SECRET=$(openssl rand -hex 16)"
  ```
- **ClickHouse validation error in v4-beta** - Either disable or use real instance:
  ```bash
  # Option 1: Bypass validation (for testing)
  railway variables --set "CLICKHOUSE_URL="
  
  # Option 2: Use ClickHouse Cloud
  railway variables --set "CLICKHOUSE_URL=https://user:pass@host.clickhouse.cloud:8443"
  ```
- **No public domain for service** - Generate Railway domain:
  ```bash
  railway domain  # Creates Railway-provided domain
  ```
- **Cross-service variables empty** - Ensure dependent services are running and named correctly

#### Service Creation Issues
- **Deploying to wrong service** - Check `railway status` to verify current service context
- **Creating webapp service** - Use `railway add --service "ServiceName"` for empty services
- **Service naming conflicts** - Service names must be unique in project
- **Corrupted service deployments** - Use `railway down -y` to remove bad deployments

### Performance Tuning

Adjust based on Railway's container resources:

```env
# For 4GB container
NODE_MAX_OLD_SPACE_SIZE=3200

# For 8GB container
NODE_MAX_OLD_SPACE_SIZE=6400
```

## 🔄 Migration from Other Deployments

### From Docker Self-Hosting

If you're migrating from a Docker-based self-hosted setup:

1. **Export your data** from existing PostgreSQL
2. **Deploy to Railway** using the instructions above
3. **Import data** to Railway PostgreSQL
4. **Update your CLI configuration**:
   ```bash
   npx trigger.dev@v4-beta login -a https://your-railway-app.railway.app
   ```
5. **Redeploy your tasks** to the new instance

### From Trigger.dev Cloud

If you want to move from Trigger.dev Cloud to Railway:

1. **Export your task code** from your existing project
2. **Deploy Railway instance** using this guide
3. **Initialize new project** with Railway URL
4. **Deploy tasks** to your Railway instance
5. **Update webhooks/integrations** to point to Railway URL

## 🛠️ Railway CLI Commands

Essential Railway CLI commands for managing your deployment:

```bash
# Project management
railway link [project-id]      # Link to existing project
railway status                  # Project status
railway open                    # Open app in browser
railway open --print-url       # Get app URL

# Service management
railway add --database postgres # Add PostgreSQL database
railway add --database redis   # Add Redis cache
railway add --database mysql   # Add MySQL database
railway add --database mongo   # Add MongoDB database

# Environment variables
railway variables               # List all variables
railway variables --json       # JSON format
railway variables --set KEY=VALUE # Set environment variable

# Deployment
railway up                      # Deploy and follow logs
railway up --detach             # Deploy without following logs

# View logs
railway logs                    # Recent logs
railway logs -f                 # Follow logs (live)
railway logs --build           # Build logs only

# Database access
railway connect PostgreSQL     # Connect to PostgreSQL
railway connect Redis          # Connect to Redis

# Advanced
railway shell                   # Connect to service shell
railway service list           # List all services in project
```

## 📚 Resources

- [Trigger.dev Documentation](https://trigger.dev/docs)
- [Self-hosting Guide](https://trigger.dev/docs/self-hosting/overview)
- [Railway Documentation](https://docs.railway.app)
- [Railway Templates](https://railway.app/templates)
- [Railway CLI Reference](https://docs.railway.app/reference/cli-api)
- [Discord Community](https://discord.gg/triggerdotdev)

## ⚡ Performance Optimization

### Railway-Specific Optimizations

```env
# Memory allocation (adjust based on Railway plan)
NODE_MAX_OLD_SPACE_SIZE=4096    # 4GB plan
NODE_MAX_OLD_SPACE_SIZE=6400    # 8GB plan

# Connection pooling for Railway PostgreSQL
DATABASE_CONNECTION_POOL_SIZE=10

# Redis configuration for Railway
REDIS_TLS_DISABLED=true         # Railway Redis uses internal TLS
```

### Scaling Recommendations

| Railway Plan | Recommended Usage | NODE_MAX_OLD_SPACE_SIZE |
|--------------|-------------------|--------------------------|
| **Starter** | Development/Testing | 1600 (2GB) |
| **Developer** | Small production | 3200 (4GB) |
| **Team** | Medium production | 6400 (8GB) |
| **Enterprise** | Large production | 12800 (16GB) |

## ❓ Frequently Asked Questions

### Q: Can I use ClickHouse for analytics?
**A:** Yes! You can use ClickHouse Cloud or self-hosted ClickHouse:

**ClickHouse Cloud:**
```bash
railway variables --set "CLICKHOUSE_URL=https://user:password@host.clickhouse.cloud:8443"
```

**Disable ClickHouse (v4-beta validation workaround):**
```bash
railway variables --set "CLICKHOUSE_URL="  # Empty string bypasses validation
```

**Note:** v4-beta has a validation bug where `CLICKHOUSE_URL` is required but should be optional.

### Q: How do I set up ClickHouse for analytics?
**A:** ClickHouse requires database and table creation after connecting:

**1. Connect to ClickHouse Cloud:**
```bash
# Test connection
curl --user 'default:YOUR_PASSWORD' \
  --data-binary 'SELECT 1' \
  https://your-host.clickhouse.cloud:8443

# Set in Railway
railway variables --set "CLICKHOUSE_URL=https://default:YOUR_PASSWORD@your-host.clickhouse.cloud:8443"
```

**2. Create required database and tables:**
```bash
# Create database
curl --user 'default:YOUR_PASSWORD' \
  --data-binary 'CREATE DATABASE IF NOT EXISTS trigger_dev' \
  https://your-host.clickhouse.cloud:8443

# Create main analytics table (copy this as single command)
curl --user 'default:YOUR_PASSWORD' \
  --data-binary 'CREATE TABLE IF NOT EXISTS trigger_dev.task_runs_v2
(
  environment_id            String,
  organization_id           String,
  project_id                String,
  run_id                    String,
  environment_type          LowCardinality(String),
  friendly_id               String,
  attempt                   UInt8     DEFAULT 1,
  engine                    LowCardinality(String),
  status                    LowCardinality(String),
  task_identifier           String,
  queue                     String,
  schedule_id               String,
  batch_id                  String,
  concurrency_key           String,
  bulk_action_group_ids     Array(String),
  worker_queue              String,
  created_at                DateTime64(3, '\''UTC'\'') DEFAULT now64(3),
  started_at                Nullable(DateTime64(3, '\''UTC'\'')),
  completed_at              Nullable(DateTime64(3, '\''UTC'\'')),
  cost_in_cents             Nullable(UInt32),
  base_cost_in_cents        Nullable(UInt32),
  duration_ms               Nullable(UInt32),
  tags                      Array(String),
  payload                   Nullable(String),
  metadata                  Map(String, String),
  context                   Nullable(String),
  machine_preset            LowCardinality(String),
  task_slug                 String,
  task_file_path            String,
  task_export_name          String,
  sdk_version               LowCardinality(String),
  cli_version               LowCardinality(String)
)
ENGINE = MergeTree()
ORDER BY (organization_id, project_id, environment_id, created_at, run_id)' \
  https://your-host.clickhouse.cloud:8443
```

**3. Verify setup:**
```bash
# Check database exists
curl --user 'default:YOUR_PASSWORD' \
  --data-binary 'SHOW DATABASES' \
  https://your-host.clickhouse.cloud:8443

# Check table exists  
curl --user 'default:YOUR_PASSWORD' \
  --data-binary 'SHOW TABLES FROM trigger_dev' \
  https://your-host.clickhouse.cloud:8443

# Test query
curl --user 'default:YOUR_PASSWORD' \
  --data-binary 'SELECT count() FROM trigger_dev.task_runs_v2' \
  https://your-host.clickhouse.cloud:8443
```

## 🐛 Advanced Troubleshooting: Known Deployment Issues

*This section documents critical issues discovered during Railway deployment testing and their solutions.*

### Redis Internal DNS Resolution (ENOTFOUND redis.railway.internal)

**Problem:** Application crashes with `getaddrinfo ENOTFOUND redis.railway.internal` errors despite Redis service running.

**Root Cause:** Railway's internal DNS only provides IPv6 addresses, but ioredis defaults to IPv4-only lookups.

**Solutions:**

**Option 1: IPv6 Support (Long-term)**
```typescript
// In redis.server.ts - add family: 0 to Redis configuration
const redis = new Redis({
  connectionName,
  host: options.host,
  port: options.port,
  username: options.username,
  password: options.password,
  family: 0, // Support both IPv4 and IPv6 (required for Railway internal DNS)
  // ... other options
});
```

**Option 2: Public Endpoint Workaround (Immediate)**
```bash
# Get Redis public endpoint details
railway service Redis
railway variables | grep -E "REDIS|RAILWAY_TCP"

# Set variables to use public endpoint
railway variables --set "REDIS_HOST=yamanote.proxy.rlwy.net"
railway variables --set "REDIS_PORT=15486"
railway variables --set "REDIS_PASSWORD=${REDIS_PASSWORD}"  # Keep existing password
```

### Database Migration Issues

**Problem:** Login fails with "The column `User.authIdentifier` does not exist" after deployment.

**Root Cause:** Database migrations didn't complete properly due to internal DNS issues or timeouts.

**Solution:**
```bash
# Use public Postgres endpoint for migrations
# Get connection details
railway service Postgres
railway variables | grep -E "DATABASE_URL|RAILWAY_TCP"

# Complete migrations using public endpoint
DATABASE_URL="postgresql://postgres:${PASSWORD}@trolley.proxy.rlwy.net:14560/railway" \
DIRECT_URL="postgresql://postgres:${PASSWORD}@trolley.proxy.rlwy.net:14560/railway" \
npx prisma migrate deploy --schema=./internal-packages/database/prisma/schema.prisma

# If migrations fail partway through, force schema sync
DATABASE_URL="postgresql://postgres:${PASSWORD}@trolley.proxy.rlwy.net:14560/railway" \
DIRECT_URL="postgresql://postgres:${PASSWORD}@trolley.proxy.rlwy.net:14560/railway" \
npx prisma db push --schema=./internal-packages/database/prisma/schema.prisma --accept-data-loss
```

### Railway Configuration Application Issues

**Problem:** Changes to `railway.json` don't apply even after git push.

**Root Cause:** `railway redeploy` only restarts existing deployment without reading new configuration files.

**Solution:**
```bash
# WRONG: This doesn't apply railway.json changes
railway redeploy --yes

# CORRECT: This uploads code and applies railway.json
railway up --detach

# Key difference:
# - railway up = Upload code + build + apply railway.json + deploy
# - railway redeploy = Restart last deployment (ignores new code/config)
```

### Authentication/Magic Link Failures

**Problem:** Magic links are authenticated but user is redirected back to login screen.

**Root Cause:** Missing database schema columns or email transport configuration.

**Solutions:**

**Database Schema:**
```bash
# Verify all required tables exist
railway connect PostgreSQL
\dt  # List tables in PostgreSQL

# If User table missing authIdentifier column, force schema sync
npx prisma db push --accept-data-loss
```

**Email Transport:**
```bash
# For development/testing, set empty email transport for console fallback
railway variables --set "EMAIL_TRANSPORT="

# For production, configure real email provider (optional)
railway variables --set "EMAIL_TRANSPORT=resend"
railway variables --set "RESEND_API_KEY=your_key"
railway variables --set "FROM_EMAIL=noreply@yourdomain.com"
```

### Service Startup Dependency Issues

**Problem:** Application starts before database/Redis services are ready.

**Root Cause:** Railway doesn't guarantee service startup order.

**Solution:**
```bash
# Ensure all services are running before deploying webapp
railway service Redis && railway status
railway service Postgres && railway status
railway service Trigger.dev && railway up --detach
```

### Internal DNS vs Public Endpoint Matrix

| Service | Internal DNS (Preferred) | Public Endpoint (Workaround) | Issue |
|---------|-------------------------|-------------------------------|-------|
| **Redis** | `redis.railway.internal:6379` | `yamanote.proxy.rlwy.net:15486` | IPv6 DNS resolution |
| **Postgres** | `postgres.railway.internal:5432` | `trolley.proxy.rlwy.net:14560` | Migration timeouts |
| **App** | `app.railway.internal` | `yourapp.railway.app` | No known issues |

### Environment Variable Debugging

**Problem:** Variables appear set but application doesn't receive them.

**Root Cause:** Cached deployment or incorrect service context.

**Debugging:**
```bash
# Check current service context
railway status

# Verify variables are set on correct service
railway variables | grep -E "DATABASE_URL|REDIS_HOST|SESSION_SECRET"

# Force fresh deployment with variables
railway up --detach

# Test variable resolution in deployed environment
railway run env | grep -E "DATABASE_URL|REDIS_HOST"
```

### Build vs Runtime Variable Issues

**Problem:** Variables work in Railway dashboard but fail during build or runtime.

**Root Cause:** Railway.json template variables vs manually set variables conflict.

**Solutions:**

**For Build Time:**
```bash
# These must be set manually (not via railway.json)
railway variables --set "SESSION_SECRET=$(openssl rand -hex 16)"
railway variables --set "MAGIC_LINK_SECRET=$(openssl rand -hex 16)"
railway variables --set "ENCRYPTION_KEY=$(openssl rand -hex 16)"
```

**For Runtime:**
```json
// railway.json - these work for runtime only
{
  "environments": {
    "production": {
      "deploy": {
        "DATABASE_URL": "${{Postgres.DATABASE_URL}}",
        "REDIS_HOST": "${{Redis.RAILWAY_PRIVATE_DOMAIN}}",
        "APP_ORIGIN": "https://${{RAILWAY_PUBLIC_DOMAIN}}"
      }
    }
  }
}
```

### Complete Recovery Procedure

If deployment fails completely, follow this recovery sequence:

```bash
# 1. Verify service context and status
railway status
railway service Redis && railway status
railway service Postgres && railway status

# 2. Fix critical environment variables
railway service Trigger.dev
railway variables --set "PORT=3030"
railway variables --set "EMAIL_TRANSPORT="
railway variables --set "SESSION_SECRET=$(openssl rand -hex 16)"

# 3. Use public endpoints for problematic services
railway variables --set "REDIS_HOST=yamanote.proxy.rlwy.net"
railway variables --set "REDIS_PORT=15486"

# 4. Complete database migrations
DATABASE_URL="postgresql://postgres:${PASSWORD}@trolley.proxy.rlwy.net:14560/railway" \
npx prisma db push --schema=./internal-packages/database/prisma/schema.prisma --accept-data-loss

# 5. Fresh deployment
railway up --detach

# 6. Monitor logs
railway logs
```

### Performance Impact of Workarounds

**Public Endpoints vs Internal DNS:**
- **Latency:** +2-5ms additional latency via public proxy
- **Security:** Still encrypted, but traffic routes through Railway's edge
- **Reliability:** Public endpoints may have different rate limits
- **Cost:** No additional charges for public endpoint usage

**When to Use Each:**
- **Development/Testing:** Public endpoints for reliability
- **Production:** Internal DNS once IPv6 support is added to codebase
- **Hybrid:** Public for migrations, internal for runtime (if working)

### Q: How do I handle file uploads/storage?
**A:** Railway provides persistent volumes. Configure `OBJECT_STORE_BASE_URL` to use Railway's file storage or integrate with external services like AWS S3.

### Q: Can I run worker containers separately?
**A:** This deployment runs tasks within the main process. For separate workers, you'd need to deploy additional Railway services with the supervisor configuration.

### Q: How do I backup my data?
**A:** Railway PostgreSQL includes automatic backups. You can also use `pg_dump` via `railway connect PostgreSQL` for manual backups.

### Q: What about custom domains?
**A:** Railway supports custom domains. Configure them in Railway dashboard and update your environment variables accordingly.

### Q: How do I monitor costs?
**A:** Check Railway dashboard for usage metrics. The deployment uses managed services which are billed based on actual usage.

## 🔒 Security Considerations

1. **HTTPS Everywhere** - Railway provides automatic HTTPS with valid certificates
2. **Private Networking** - Services communicate internally via Railway's private network
3. **Environment Variables** - Secrets are encrypted at rest in Railway
4. **Access Control** - Use `WHITELISTED_EMAILS` for private instances
5. **Regular Updates** - Keep dependencies updated via Railway's auto-deployment
6. **Monitoring** - Enable Railway's built-in monitoring and alerts

## 🆘 Support

- **Railway Issues**: Railway-specific deployment problems
- **Trigger.dev Community**: Join our [Discord](https://discord.gg/triggerdotdev)
- **GitHub Issues**: Report bugs on [GitHub](https://github.com/triggerdotdev/trigger.dev/issues)
- **Documentation**: 
  - [Trigger.dev Docs](https://trigger.dev/docs/self-hosting/overview)
  - [Railway Docs](https://docs.railway.app)

---

🎉 **You're all set!** Your Trigger.dev instance is now running on Railway with zero configuration required. Enjoy the simplified deployment and Railway's excellent developer experience!