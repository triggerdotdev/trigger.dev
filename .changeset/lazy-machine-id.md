---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Generate the machine ID and the managed run controller ID on first use instead of at import, so importing these modules draws no randomness and a process restored from a warm start does not reuse IDs drawn before it was saved.
