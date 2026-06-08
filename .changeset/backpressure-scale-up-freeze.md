---
"@trigger.dev/core": patch
---

Add optional `shouldPauseScaling` to the supervisor consumer pool scaling options to freeze scale-up while it returns true (scale-down stays allowed).
