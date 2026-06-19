---
"trigger.dev": patch
---

Adds `trigger.dev mint-token`, which mints a short-lived delegated token from your stored personal access token. The token authenticates against the API as you, can be narrowed with `--cap` and given a lifetime with `--ttl`, and prints to stdout so it can be captured.

```bash
UAT=$(trigger.dev mint-token --ttl 3600 --cap read:runs)
```
