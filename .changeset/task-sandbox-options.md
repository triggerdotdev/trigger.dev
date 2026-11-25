---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Use `sandbox: true` to run a deployed task with access limited to its own payload and output. Configure `sandbox.envVars` and `sandbox.scopes` to grant environment variables or additional permissions, including the `basic` and `oidc` presets. `basic` lets a sandbox inspect and manage its own run (including metadata and tags), and exchange messages with its attached Session, including waiting for input. Upgrade the SDK, CLI, and (when self-hosting) server before adopting this option. `trigger dev` still runs locally with development credentials and is not an isolation boundary.
