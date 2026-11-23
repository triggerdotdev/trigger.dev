---
"trigger.dev": patch
"@trigger.dev/core": patch
---

`trigger deploy` warns when deploys from your CLI version will soon stop being supported, with the last day they still work and the command to upgrade. The warning never blocks a deploy and shows on every build path, including `--native-build`, `--local-build` and `--depot-build`. Deploys that authenticate with GitHub OIDC don't show it.
