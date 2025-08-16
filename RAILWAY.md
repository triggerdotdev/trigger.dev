# Railway Deployment Guide for Trigger.dev

Complete documentation for deploying Trigger.dev on Railway - from quick deployment to template creation.

## 📚 Documentation Index

| Document | Purpose | Status |
|----------|---------|---------|
| **[RAILWAY.md](./RAILWAY.md)** | This file - main documentation hub | ✅ Current |
| **[RAILWAY_DEPLOYMENT.md](./RAILWAY_DEPLOYMENT.md)** | Complete deployment guide with troubleshooting | ✅ Production-ready |
| **[RAILWAY_TEMPLATE.md](./RAILWAY_TEMPLATE.md)** | Template marketplace documentation | ✅ Ready for submission |
| **[RAILWAY_TEMPLATE_CHECKLIST.md](./RAILWAY_TEMPLATE_CHECKLIST.md)** | Step-by-step template creation checklist | ✅ Complete |
| **[railway.json](./railway.json)** | Railway configuration file | ✅ Working |
| **[railway-template.json](./railway-template.json)** | Template marketplace configuration | ✅ Configured |
| **[.railway/migrate.sh](./.railway/migrate.sh)** | Migration optimization script (~1 min vs 20+ min) | ✅ Optimized |

## 🚀 Quick Start

### Option 1: Deploy from Button (Fastest)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/nick0lay/trigger.dev&branch=feature/DEV-0000-setup-deployment-to-railway)

### Option 2: Railway CLI

```bash
railway login
railway init --template https://github.com/nick0lay/trigger.dev
```

### Option 3: Manual Setup

```bash
# Create project and add services
railway init
railway add --database postgres
railway add --database redis

# Set required secrets
railway variables --set SESSION_SECRET="$(openssl rand -hex 16)"
railway variables --set MAGIC_LINK_SECRET="$(openssl rand -hex 16)"
railway variables --set ENCRYPTION_KEY="$(openssl rand -hex 32)"
railway variables --set MANAGED_WORKER_SECRET="$(openssl rand -hex 16)"
railway variables --set PORT="3030"

# Deploy
railway up --detach
```

## 🧪 Template Testing Scenarios

After pushing to GitHub, test your template deployment with these three approaches:

### Scenario 1: Deploy from Railway Button

**Location**: Button in [RAILWAY_DEPLOYMENT.md](./RAILWAY_DEPLOYMENT.md#quick-deploy)

```bash
# Direct template URL after pushing to GitHub
https://railway.app/new/template?template=https://github.com/nick0lay/trigger.dev&branch=feature/DEV-0000-setup-deployment-to-railway
```

**Test Steps:**
1. Open URL in incognito browser
2. Verify GitHub repository is detected
3. Check PostgreSQL and Redis services are offered
4. Confirm environment variables show placeholders
5. Click Deploy and monitor logs

### Scenario 2: Deploy from Railway CLI

```bash
# Install Railway CLI if needed
curl -fsSL https://railway.app/install.sh | sh

# Test template deployment
railway login
railway init --template https://github.com/nick0lay/trigger.dev --branch feature/DEV-0000-setup-deployment-to-railway

# This will:
# - Create new Railway project
# - Clone repository
# - Apply railway.json configuration
# - Provision PostgreSQL and Redis
```

**Verification:**
```bash
railway status       # Check services created
railway variables    # Verify environment variables
railway logs -f      # Monitor deployment
```

### Scenario 3: Deploy from Railway Marketplace

**Prerequisites**: Template must be published to marketplace

1. **Generate Template** (if not done):
   - Go to your Railway project
   - Settings → Generate Template
   - Fill in template details

2. **Test Marketplace URL**:
   ```bash
   https://railway.app/template/[your-template-id]
   ```

3. **Verify Template Features**:
   - [ ] Template appears in Railway marketplace
   - [ ] Icon and description display correctly
   - [ ] Services provision automatically
   - [ ] Environment variables pre-configured
   - [ ] Deployment completes successfully

## 📋 Deployment Architecture

### Minimal Setup (Current)
```
┌─────────────────┐
│   Trigger.dev   │  ← Main webapp (Remix)
│   (railway.json)│
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
┌────▼──┐ ┌──▼────┐
│Postgres│ │ Redis │  ← Railway managed services
└────────┘ └───────┘
```

### Future Full Stack (Optional)
```
┌─────────────────┐
│   Trigger.dev   │
└────────┬────────┘
         │
    ┌────┼────────┬──────────┬─────────┐
    │    │        │          │         │
┌────▼──┐ ┌──▼──┐ ┌─▼──────┐ ┌──▼───────┐ ┌──▼────┐
│Postgres│ │Redis│ │ClickHouse│ │ElectricSQL│ │CH-UI │
└────────┘ └─────┘ └──────────┘ └───────────┘ └───────┘
```

## 🔧 Configuration Files

### railway.json
- **Purpose**: Service build/deploy configuration
- **Used by**: Your current Railway deployment
- **Contains**: Build commands, environment variables, health checks

### railway-template.json  
- **Purpose**: Template marketplace definition
- **Used by**: Railway template system
- **Contains**: Same as railway.json but for template creation

### Key Differences
| Aspect | railway.json | railway-template.json |
|--------|--------------|----------------------|
| **When used** | Every deployment | Template creation only |
| **Environment vars** | References existing | Defines what to create |
| **Services** | Assumes exist | Instructs to provision |

## ⚡ Quick Commands Reference

### Deployment
```bash
railway up --detach         # Deploy with railway.json
railway logs -f            # Follow logs
railway status             # Check deployment status
railway open               # Open app in browser
```

### Environment Variables
```bash
railway variables          # List all variables
railway variables --set KEY=VALUE  # Set variable
railway domain            # Generate public domain
```

### Services
```bash
railway add --database postgres    # Add PostgreSQL
railway add --database redis      # Add Redis
railway connect PostgreSQL        # Connect to database
```

### Troubleshooting
```bash
railway logs --build      # View build logs
railway service list      # List all services
railway redeploy         # Restart deployment
```

## 🐛 Common Issues & Solutions

### Issue: "Service does not have a source"
**Cause**: Not connected to GitHub repository
**Fix**: Connect service to GitHub in Railway dashboard

### Issue: Missing environment variables
**Cause**: Secrets not manually set
**Fix**: 
```bash
railway variables --set SESSION_SECRET="$(openssl rand -hex 16)"
railway variables --set MAGIC_LINK_SECRET="$(openssl rand -hex 16)"
railway variables --set ENCRYPTION_KEY="$(openssl rand -hex 32)"
railway variables --set MANAGED_WORKER_SECRET="$(openssl rand -hex 16)"
```

### Issue: PORT validation error
**Cause**: Remix apps need explicit port
**Fix**: `railway variables --set PORT=3030`

### Issue: Redis connection errors
**Status**: ✅ RESOLVED - IPv6 DNS fix in `@internal/redis`

## 📊 Deployment Checklist

### Pre-deployment
- [ ] Code pushed to public GitHub repository
- [ ] Branch: `feature/DEV-0000-setup-deployment-to-railway`
- [ ] Files: `railway.json`, `.railway/migrate.sh`, `.env.example`

### During Deployment
- [ ] PostgreSQL service created
- [ ] Redis service created  
- [ ] Environment variables configured
- [ ] Public domain generated
- [ ] Build completes successfully
- [ ] Migration runs (~1 minute)
- [ ] Health check passes

### Post-deployment
- [ ] App accessible via public URL
- [ ] Magic link in logs (if no email configured)
- [ ] Can create first project
- [ ] Tasks deploy successfully

## 🎯 Next Steps

1. **Push to GitHub**:
   ```bash
   git add .
   git commit -m "Add Railway deployment configuration"
   git push origin feature/DEV-0000-setup-deployment-to-railway
   ```

2. **Test Deployment**: Use any of the three scenarios above

3. **Submit Template** (optional):
   - Generate template from Railway project
   - Submit to Railway marketplace
   - Share with community

## 📚 Additional Resources

- [Full Deployment Guide](./RAILWAY_DEPLOYMENT.md) - Complete instructions with troubleshooting
- [Template Documentation](./RAILWAY_TEMPLATE.md) - Template features and roadmap
- [Railway Docs](https://docs.railway.app) - Official Railway documentation
- [Trigger.dev Docs](https://trigger.dev/docs) - Official Trigger.dev documentation
- [Discord Community](https://discord.gg/triggerdotdev) - Get help and share feedback

## 🎉 Success Metrics

Your Railway deployment is successful when:
- ✅ All services running (webapp, PostgreSQL, Redis)
- ✅ Public URL accessible
- ✅ Can log in with magic link
- ✅ Can create and deploy tasks
- ✅ Migrations complete in ~1 minute (not 20+)
- ✅ No Redis DNS errors

---

**Current Status**: Template ready for testing and submission to Railway marketplace

**Support**: For Railway-specific issues, check [RAILWAY_DEPLOYMENT.md](./RAILWAY_DEPLOYMENT.md#troubleshooting). For general Trigger.dev questions, visit our [Discord](https://discord.gg/triggerdotdev).