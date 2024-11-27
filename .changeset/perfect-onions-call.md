---
"@trigger.dev/sdk": patch
"trigger.dev": patch
"@trigger.dev/core": patch
---

Added new batch.trigger and batch.triggerByTask methods that allows triggering multiple different tasks in a single batch:

```ts
import { batch } from '@trigger.dev/sdk/v3';
import type { myTask1, myTask2 } from './trigger/tasks';

// Somewhere in your backend code
const response = await batch.trigger<typeof myTask1 | typeof myTask2>([
  { id: 'task1', payload: { foo: 'bar' } },
  { id: 'task2', payload: { baz: 'qux' } },
]);

for (const run of response.runs) {
  if (run.ok) {
    console.log(run.output);
  } else {
    console.error(run.error);
  }
}
```

Or if you are inside of a task, you can use `triggerByTask`:

```ts
import { batch, task, runs } from '@trigger.dev/sdk/v3';

export const myParentTask = task({
  id: 'myParentTask',
  run: async () => {
    const response = await batch.triggerByTask([
      { task: myTask1, payload: { foo: 'bar' } },
      { task: myTask2, payload: { baz: 'qux' } },
    ]);

    const run1 = await runs.retrieve(response.runs[0]);
    console.log(run1.output) // typed as { foo: string }

    const run2 = await runs.retrieve(response.runs[1]);
    console.log(run2.output) // typed as { baz: string }

    const response2 = await batch.triggerByTaskAndWait([
      { task: myTask1, payload: { foo: 'bar' } },
      { task: myTask2, payload: { baz: 'qux' } },
    ]);

    if (response2.runs[0].ok) {
      console.log(response2.runs[0].output) // typed as { foo: string }
    }

    if (response2.runs[1].ok) {
      console.log(response2.runs[1].output) // typed as { baz: string }
    }
  }
});

export const myTask1 = task({
  id: 'myTask1',
  run: async () => {
    return {
      foo: 'bar'
    }
  }
});

export const myTask2 = task({
  id: 'myTask2',
  run: async () => {
    return {
      baz: 'qux'
    }
  }
});

```
