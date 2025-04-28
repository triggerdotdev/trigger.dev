---
"trigger.dev": patch
"@trigger.dev/core": patch
---

- Fix polling interval reset bug that could create duplicate intervals
- Protect against unexpected attempt number changes
- Prevent run execution zombies after warm starts