---
"@trigger.dev/sdk": patch
---

Undo, edit and regenerate now survive a run ending. History rolled back from `onAction` was only kept in the running worker's memory, so the rollback held while that worker stayed warm and then reverted on the next continuation — the undone messages came back, minutes later, with no error.
