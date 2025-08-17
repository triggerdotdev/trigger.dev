---
"@trigger.dev/sdk": patch
---

Added and cleaned up the run ctx param:

- New optional properties `ctx.run.parentTaskRunId` and `ctx.run.rootTaskRunId` reference the current run's root/parent ID.
- Removed deprecated properties from `ctx`
- Added a new `ctx.deployment` object that contains information about the deployment associated with the run.

We also update `metadata.root` and `metadata.parent` to work even when the run is a "root" run (meaning it doesn't have a parent or a root associated run). This now works:

```ts
metadata.root.set("foo", "bar");
metadata.parent.set("baz", 1);
metadata.current().foo // "bar"
metadata.current().baz // 1
```
