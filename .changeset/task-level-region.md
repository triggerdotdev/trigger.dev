---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
"trigger.dev": patch
---

Tasks can now declare the region(s) they may run in with `region: "eu-central-1"` or `region: ["eu-central-1", "us-east-1"]` in the task definition. A `region` passed when triggering must be one of them, otherwise the trigger is rejected. When no region is passed, the project's default region is used if the task allows it, otherwise the first region in the list. Deploys fail early if a task names a region that doesn't exist or isn't available to the project. The option is ignored in dev.

```ts
export const euOnlyTask = task({
  id: "eu-only-task",
  region: "eu-central-1",
  run: async (payload) => {
    // ...
  },
});
```
