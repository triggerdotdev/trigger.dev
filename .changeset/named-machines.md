---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
"trigger.dev": patch
---

Add `defineMachine()` for tasks that need their own image. A machine adds apt packages or Containerfile instructions on top of the project image and sets a default preset. Set it as a task's `machine` and the deploy builds its image. Available only to early testers.
