---
area: webapp
type: improvement
---

Stop creating TaskRunTag records and _TaskRunToTaskRunTag join table entries during task triggering. The denormalized runTags string array on TaskRun already stores tag names, making the M2M relation redundant write overhead.
