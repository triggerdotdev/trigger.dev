---
"trigger.dev": patch
---

Add `trigger webhooks set-secret` and `trigger webhooks generate-secret`, which store a webhook endpoint's signing secret without printing it. `set-secret` reads the secret from a pipe, an environment variable or a `.env` file, and `generate-secret` saves the new secret to an env file. When the endpoint already has a secret, both ask how long the old one keeps working (or take `--previous-secret-ttl 24h` in scripts). The MCP server's `set_webhook_secret` and `generate_webhook_secret` descriptions now point AI agents at these commands, so the secret stays out of the agent's context.
