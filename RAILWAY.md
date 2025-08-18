# Deploy Trigger.dev on Railway

**One-click deployment of Trigger.dev with automated PostgreSQL, Redis, and optimized configuration.**

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/7mkz-R?referralCode=CG2P3Y)

## 🚀 Quick Deploy (Recommended)

**Template URL**: https://railway.com/deploy/7mkz-R?referralCode=CG2P3Y

**What you get**:
- ✅ Trigger.dev webapp ready for production
- ✅ PostgreSQL database with automatic connections
- ✅ Redis cache with IPv6 DNS fix
- ✅ All environment variables auto-configured
- ✅ Migration optimization (~1 minute vs 20+ minutes)
- ✅ Auto-generated secure secrets
- ✅ Public domain with health checks

**Deployment time**: ~5 minutes from click to running application

## 🔧 Alternative Deployment Methods

### Manual GitHub Deployment
1. Go to Railway Dashboard → New Project → Deploy from GitHub repo
2. Select: `nick0lay/trigger.dev`
3. Branch: `feature/DEV-0000-setup-deployment-to-railway`
4. Railway auto-applies `railway.json` configuration

### Railway CLI
```bash
railway login
railway init --template https://github.com/nick0lay/trigger.dev
```

### Complete Manual Setup
```bash
# Create project and services
railway init
railway add --database postgres
railway add --database redis

# Generate required secrets
railway variables --set "SESSION_SECRET=$(openssl rand -hex 16)"
railway variables --set "MAGIC_LINK_SECRET=$(openssl rand -hex 16)"
railway variables --set "ENCRYPTION_KEY=$(openssl rand -hex 32)"
railway variables --set "MANAGED_WORKER_SECRET=$(openssl rand -hex 16)"

# Configure service connections (Railway auto-provides these references)
railway variables --set "DATABASE_URL=\${{Postgres.DATABASE_URL}}"
railway variables --set "REDIS_HOST=\${{Redis.RAILWAY_PRIVATE_DOMAIN}}"
railway variables --set "API_ORIGIN=https://\${{RAILWAY_PUBLIC_DOMAIN}}"

# Deploy
railway up --detach
```

## 🎯 Post-Deployment

After deployment completes:

1. **Access your app**: Railway provides a public URL
2. **Sign in**: Use magic link authentication (check logs if no email configured)
3. **Create project**: Set up your first Trigger.dev project
4. **Deploy tasks**: Use the CLI to deploy background jobs

```bash
# Connect to your deployed instance
npx trigger.dev@v4-beta init -a https://your-app.railway.app

# Deploy your first task
npx trigger.dev@v4-beta deploy
```

## 🐛 Troubleshooting

### Template Issues

**"Missing variable details" error when creating template:**
1. Go to Railway template editor
2. **DELETE** auto-generated service variables (REDISPORT, POSTGRES_USER, RAILWAY_*, etc.)
3. **KEEP** only user-configurable variables (SESSION_SECRET, MAGIC_LINK_SECRET, etc.)
4. Set template functions as defaults with regular quotes: `SESSION_SECRET: Default = "${{secret(32, "abcdef0123456789")}}"`

**"Unbalanced quotes in configuration line" error:**
- **Primary Cause**: Using escaped quotes (`\"`) inside template functions instead of regular quotes (`"`)
- **Fix**: Change `${{secret(32, \"abcdef0123456789\")}}` to `${{secret(32, "abcdef0123456789")}}`
- **Secondary Cause**: Using template functions in managed Redis/PostgreSQL services
- **Solution**: Only use template functions in application services, not database services

### Common Deployment Issues
- **Migration timeout**: ✅ Resolved with baseline optimization
- **Redis connection errors**: ✅ Resolved with IPv6 DNS fix
- **Missing environment variables**: Template auto-configures all required variables
- **Build failures**: Check Railway build logs for specific errors

### Manual Setup Troubleshooting
```bash
# Check if variables are set correctly
railway variables

# Test variable resolution
railway run env | grep DATABASE_URL

# Check service names
railway service list
```

### Get Help
- **Trigger.dev support**: [Discord community](https://discord.gg/triggerdotdev)
- **Railway platform**: [Railway documentation](https://docs.railway.com)

## 📊 Deployment Comparison

| Aspect | Template (Recommended) | Manual Setup |
|--------|----------------------|--------------|
| **Deployment time** | ~5 minutes | ~30+ minutes |
| **Configuration** | Automatic | Manual setup required |
| **Error prone** | Minimal | High (many steps) |
| **Environment variables** | Auto-configured | Manual generation/setup |
| **Service connections** | Automatic | Manual references |
| **Maintenance** | Auto-updates | Manual updates |

## 🔧 Template Configuration (For Maintainers)

### Railway Template System
- **Config file**: Only `railway.json` (Railway doesn't use `railway-template.json`)
- **Template setup**: Done through Railway web interface, not config files
- **Variable management**: Use Railway template functions and service references

### Using Custom Branches in Templates

**⚠️ Railway Limitation**: Templates default to the `main` branch with no direct UI option to change it after creation.

**✅ Workaround - Specify Branch in Source URL**:
When setting the "Source repo" in template configuration, use this format:
```
https://github.com/nick0lay/trigger.dev/tree/feature-branch
```

This automatically creates the template using `feature-branch` instead of `main`.

**Example for this project**:
```
https://github.com/nick0lay/trigger.dev/tree/feature/DEV-0000-setup-deployment-to-railway
```

**Alternative Approaches**:
1. **Create new template**: Start from desired branch and generate template from that deployment
2. **Manual deployment**: Deploy from custom branch first, then generate template
3. **Edit service source**: Some template composers allow editing source URLs per service

**Note**: This is a limitation of Railway's template system - provide feedback to Railway team if branch management is crucial for your workflow.

### Correct Template Function Syntax

**✅ Examples of CORRECT syntax:**
```bash
# Hex secrets (openssl rand -hex 16 equivalent)
"${{secret(32, "abcdef0123456789")}}"

# Base64 secrets (openssl rand -base64 32 equivalent)
"${{secret(43, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/")}}"

# Random integer
"${{randomInt(1000, 9999)}}"
```

**❌ Common MISTAKES to avoid:**
```bash
# Wrong: Escaped quotes inside function
"${{secret(32, \"abcdef0123456789\")}}"  # Causes "Unbalanced quotes" error

# Wrong: Single quotes
"${{secret(32, 'abcdef0123456789')}}"  # Not supported

# Wrong: No quotes at all
"${{secret(32, abcdef0123456789)}}"  # Invalid syntax
```

### Template Variables

**⚠️ Critical**: Use regular quotes inside template functions, NOT escaped quotes!

```bash
# ✅ CORRECT - Regular quotes inside template function
SESSION_SECRET="${{secret(32, "abcdef0123456789")}}"
MAGIC_LINK_SECRET="${{secret(32, "abcdef0123456789")}}"
ENCRYPTION_KEY="${{secret(64, "abcdef0123456789")}}"
MANAGED_WORKER_SECRET="${{secret(32, "abcdef0123456789")}}"

# ❌ WRONG - Escaped quotes break template functions
SESSION_SECRET="${{secret(32, \"abcdef0123456789\")}}"  # This will fail!
```

**Important Notes**:
- Template functions only work for application services, NOT for managed Redis/PostgreSQL services
- Use regular quotes (`"`) inside template functions, not escaped quotes (`\"`)
- Escaped quotes cause "Unbalanced quotes" errors

**Service Connections (reference managed services)**:
```bash
DATABASE_URL="${{Postgres.DATABASE_URL}}"
REDIS_HOST="${{Redis.RAILWAY_PRIVATE_DOMAIN}}"
REDIS_PASSWORD="${{Redis.REDISPASSWORD}}"
REDIS_URL="${{Redis.REDIS_URL}}"
API_ORIGIN="https://${{RAILWAY_PUBLIC_DOMAIN}}"
```

**Managed Services (PostgreSQL/Redis)**: Let Railway auto-generate credentials - don't set custom variables.

## 📚 Configuration Files

```
✅ railway.json          # Railway deployment configuration
✅ .railway/migrate.sh   # Migration optimization script
✅ .env.example          # Environment variable template
❌ railway-template.json # NOT used by Railway
```

---

**Current Status**: ✅ Template live on Railway marketplace  
**Recommended**: Use the template for fastest, most reliable deployment  
**Template URL**: https://railway.com/deploy/7mkz-R?referralCode=CG2P3Y