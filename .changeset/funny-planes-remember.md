---
"@trigger.dev/build": patch
---

syncVercelEnvVars to skip API and read env vars directly from env.process for Vercel build environments. New syncNeonEnvVars build extension for syncing environment variablesfrom Neon database projects to Trigger.dev. The extension automatically detects branches and builds appropriate PostgreSQL connection strings for non-production environments (staging, dev, preview).
