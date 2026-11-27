---
"trigger.dev": patch
"@trigger.dev/core": patch
---

Resume a deployed task as soon as its run is restored after a wait. A run that was suspended during a wait (`wait.for`, `triggerAndWait`, a waitpoint token or session input) could take up to 5 seconds longer than needed to continue, and the waits it finished after that, or a cancellation, could reach the task with the same delay.
