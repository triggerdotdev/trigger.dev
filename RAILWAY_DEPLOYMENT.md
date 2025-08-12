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
DATABASE_URL=${{PostgreSQL.DATABASE_URL}}
REDIS_HOST=${{Redis.RAILWAY_PRIVATE_DOMAIN}}
REDIS_PORT=${{Redis.REDISPORT}}
APP_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
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

#### Railway CLI issues
- **`railway add postgresql` fails** - Use correct syntax: `railway add --database postgres`
- **`railway add redis` fails** - Use correct syntax: `railway add --database redis`  
- **Services not appearing after add** - Run `railway status` to verify, may need to refresh
- **"Service: None" after linking** - This is normal before adding services

#### Railway-specific issues  
- **Service references not working** - Ensure services are named correctly (PostgreSQL, Redis)
- **Private domain resolution** - Check that `RAILWAY_PRIVATE_DOMAIN` variables are available
- **Port conflicts** - Railway auto-assigns ports, no manual configuration needed
- **Cross-service variables not populating** - Verify service names match exactly (case-sensitive)

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
**A:** Not in this simplified deployment. ClickHouse requires additional setup. Railway's built-in analytics may be sufficient for most use cases.

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