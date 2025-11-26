---
"@trigger.dev/sdk": patch
"trigger.dev": patch
---

chore: restricted our dependencies semver constraints to be less permissive, from using the caret `^` constraint to using the tilde constraint `~`, going from permitting minor updates to only permitting patch updates
