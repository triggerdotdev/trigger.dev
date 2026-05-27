---
"@trigger.dev/core": patch
---

Fix `TypeError` in `unflattenAttributes` when the input attribute map contains conflicting dotted key paths (e.g. both `a.b` set to a scalar and `a.b.c` set to a value). The path-walk loop now applies last-write-wins when a prior key wrote a primitive, null, or array at an intermediate slot, matching the existing precedent in `AttributeFlattener.addAttribute`. Callers no longer crash when handed malformed external attribute inputs.
