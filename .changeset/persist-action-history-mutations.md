---
"@trigger.dev/sdk": patch
---

Undo, edit and regenerate now survive a run ending. History rolled back from `onAction` was only kept in the running worker's memory, so the rollback held while that worker stayed warm and then reverted on the next continuation. The undone messages came back, minutes later, with no error. This also holds when the turn before the action failed: the rollback used to be written against the cursor from before that turn, so a continuation could replay output the failed turn had already superseded.
