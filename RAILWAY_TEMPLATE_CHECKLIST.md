# Railway Template Submission Checklist

## ✅ Prerequisites

### Repository Setup
- [ ] Code pushed to **public** GitHub repository (required for templates)
- [ ] Repository URL: `https://github.com/nick0lay/trigger.dev`
- [ ] Default branch: `feature/DEV-0000-setup-deployment-to-railway`

### Required Files
- [x] `railway.json` - Main Railway configuration (you already have this working perfectly)
- [x] `railway-template.json` - Template configuration for Railway marketplace  
- [x] `.railway/migrate.sh` - Migration optimization script
- [x] `RAILWAY_TEMPLATE.md` - Template documentation
- [x] `.env.example` - Environment variable template

### ❌ NOT Needed
- ~~`railway.toml`~~ - Redundant with `railway.json` (Railway supports either format, not both)

## 🚀 Template Creation Steps

### Step 1: Push to GitHub
```bash
# Add Railway-specific files
git add railway.json railway-template.json .railway/ RAILWAY_TEMPLATE.md RAILWAY_TEMPLATE_CHECKLIST.md

# Commit changes
git commit -m "Add Railway template configuration for one-click deployment

- Add railway-template.json for template marketplace
- Update Deploy to Railway buttons in RAILWAY_TEMPLATE.md
- Include migration optimization with .railway/migrate.sh
- Use existing railway.json (remove redundant railway.toml)
- Support minimal deployment (core services only)
- Prepare for future ClickHouse/ElectricSQL integration

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>"

# Push to GitHub
git push origin feature/DEV-0000-setup-deployment-to-railway
```

### Step 2: Fix GitHub Repository Connection
Since you're getting "Service does not have a source" error:

1. **Option A: Re-deploy from GitHub**
   ```bash
   # Create new Railway project from GitHub
   railway login
   railway init --name trigger-dev-template
   
   # Link to GitHub repository
   railway link
   # Select "Empty Service" 
   # Then connect GitHub repo through Railway dashboard
   ```

2. **Option B: Use Railway Dashboard**
   - Go to your Railway project
   - Click on the service that shows the error
   - Go to Settings → Source
   - Click "Connect to GitHub"
   - Select repository: `nick0lay/trigger.dev`
   - Select branch: `feature/DEV-0000-setup-deployment-to-railway`

### Step 3: Generate Template
Once GitHub is connected:

1. Go to Railway Dashboard → Your Project
2. Click "Settings" (gear icon)
3. Click "Generate Template"
4. Fill in template details:
   - **Name**: Trigger.dev
   - **Description**: Open source background jobs platform
   - **Tags**: nodejs, typescript, background-jobs, queue
   - **Icon**: Upload or use URL

### Step 4: Test Template Deployment

Test each deployment option:

#### Minimal Deployment (Current Setup)
```bash
# Test with core services only
https://railway.app/new/template?template=https://github.com/nick0lay/trigger.dev
```

#### Full Deployment (Future)
When adding ClickHouse/ElectricSQL:
```bash
# Will include all services
https://railway.app/new/template/github.com/nick0lay/trigger.dev?includeOptional=true
```

## 📝 Template Variables Configuration

### Required Secrets (User Must Provide)
```bash
SESSION_SECRET      # Generate: openssl rand -hex 16
MAGIC_LINK_SECRET   # Generate: openssl rand -hex 16  
ENCRYPTION_KEY      # Generate: openssl rand -hex 32
MANAGED_WORKER_SECRET # Generate: openssl rand -hex 16
```

### Auto-Configured (Railway Services)
```bash
DATABASE_URL        # From Postgres service
REDIS_HOST          # From Redis service
REDIS_PORT          # From Redis service
REDIS_PASSWORD      # From Redis service
RAILWAY_PUBLIC_DOMAIN # Auto-generated
```

### Optional Services (Future Enhancement)
```bash
CLICKHOUSE_URL      # Empty = disabled
ELECTRIC_ORIGIN     # Empty = disabled
```

## 🔍 Validation Checklist

### Before Submission
- [ ] railway.json validates against schema (your existing file is perfect)
- [ ] railway-template.json includes all required services
- [ ] Migration script works for fresh deployments
- [ ] Deploy buttons have correct URLs
- [ ] Environment variables properly documented

### Testing
- [ ] Fresh deployment completes successfully
- [ ] Migrations run in ~1 minute (not 20+)
- [ ] Health check passes after deployment
- [ ] Redis connection works (no DNS errors)
- [ ] PostgreSQL connection established
- [ ] Web UI accessible via public domain

### Documentation
- [ ] README includes Deploy to Railway button
- [ ] RAILWAY_TEMPLATE.md explains deployment options
- [ ] Troubleshooting section covers common issues
- [ ] Migration optimization documented

## 🎯 Deploy Button Formats

### Standard Template URL
```markdown
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/github.com/nick0lay/trigger.dev)
```

### With Environment Variables
```markdown
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Fnick0lay%2Ftrigger.dev&envs=SESSION_SECRET%2CMAGIC_LINK_SECRET%2CENCRYPTION_KEY%2CMANAGED_WORKER_SECRET)
```

### With Optional Services (Future)
```markdown
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/github.com/nick0lay/trigger.dev?services=webapp,postgres,redis,clickhouse,electric)
```

## 🐛 Common Issues & Solutions

### "Service does not have a source" Error
**Cause**: Service not connected to GitHub repository
**Solution**: Connect service to GitHub repo in Railway dashboard

### Template Not Found
**Cause**: Repository is private or path incorrect
**Solution**: Make repository public, verify URL format

### Environment Variables Missing
**Cause**: Template.json doesn't define required variables
**Solution**: Add variable definitions to template.json

### Build Failures
**Cause**: Missing dependencies or incorrect paths
**Solution**: Verify railway.toml build commands

## 📊 Template Metrics to Track

After template is live:
- [ ] Number of deployments
- [ ] Success rate
- [ ] Average deployment time
- [ ] User feedback/issues
- [ ] Fork count

## 🚢 Final Submission

### Railway Template Page
1. Visit: https://railway.app/templates
2. Click "Submit Template"
3. Enter GitHub repository URL
4. Review auto-populated information
5. Submit for review

### GitHub Repository
1. Add topic: `railway-template`
2. Update repository description
3. Pin RAILWAY_TEMPLATE.md issue
4. Enable discussions for support

## 📅 Post-Launch Tasks

- [ ] Monitor template deployments
- [ ] Respond to user issues
- [ ] Update documentation based on feedback
- [ ] Plan ClickHouse/ElectricSQL integration
- [ ] Create video tutorial
- [ ] Write blog post about Railway deployment

## 🎉 Success Criteria

Template is successful when:
- ✅ 10+ successful deployments
- ✅ No critical issues reported
- ✅ Average deployment time < 5 minutes
- ✅ Positive user feedback
- ✅ Listed on Railway templates page

---

**Current Status**: Ready for GitHub push and template generation

**Next Steps**: 
1. Push code to GitHub
2. Connect Railway service to GitHub
3. Generate template from project
4. Test deployment
5. Submit to Railway templates