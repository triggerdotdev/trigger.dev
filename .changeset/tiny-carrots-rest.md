---
"@trigger.dev/sdk": minor
---

Prevent uncaught errors in the `onSuccess`, `onComplete`, and `onFailure` lifecycle hooks from failing attempts/runs.

Deprecated the `onStart` lifecycle hook (which only fires before the `run` function on the first attempt). Replaced with `onStartAttempt` that fires before the run function on every attempt:

```ts
export const taskWithOnStartAttempt = task({
  id: "task-with-on-start-attempt",
  onStartAttempt: async ({ payload, ctx }) => {
    //...
  },
  run: async (payload: any, { ctx }) => {
    //...
  },
});

// Default a global lifecycle hook using tasks
tasks.onStartAttempt(({ ctx, payload, task }) => {
  console.log(
    `Run ${ctx.run.id} started on task ${task} attempt ${ctx.run.attempt.number}`,
    ctx.run
  );
});
```

If you want to execute code before just the first attempt, you can use the `onStartAttempt` function and check `ctx.run.attempt.number === 1`:

```ts /trigger/on-start-attempt.ts
export const taskWithOnStartAttempt = task({
  id: "task-with-on-start-attempt",
  onStartAttempt: async ({ payload, ctx }) => {
    if (ctx.run.attempt.number === 1) {
      console.log("Run started on attempt 1", ctx.run);
    }
  },
});
```

