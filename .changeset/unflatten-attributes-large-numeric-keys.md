---
"@trigger.dev/core": patch
---

Fix a crash when unflattening attributes that hold an object whose keys are all large numbers, such as millisecond timestamps. Those values now come back as an object instead of throwing an "Invalid array length" error.
