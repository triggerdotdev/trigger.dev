# Trigger.dev Realtime

**Real-time monitoring and updates for runs**

## Core Concepts

Realtime allows you to:

- Subscribe to run status changes, metadata updates, and streams
- Build real-time dashboards and UI updates
- Monitor task progress from frontend and backend
- Send data into running tasks with input streams

## Authentication

### Public Access Tokens

```ts
import { auth } from "@trigger.dev/sdk";

// Read-only token for specific runs
const publicToken = await auth.createPublicToken({
  scopes: {
    read: {
      runs: ["run_123", "run_456"],
      tasks: ["my-task-1", "my-task-2"],
    },
  },
  expirationTime: "1h", // Default: 15 minutes
});
```

### Trigger Tokens (Frontend only)

```ts
// Single-use token for triggering tasks
const triggerToken = await auth.createTriggerPublicToken("my-task", {
  expirationTime: "30m",
});
```

## Backend Usage

### Subscribe to Runs

```ts
import { runs, tasks } from "@trigger.dev/sdk";

// Trigger and subscribe
const handle = await tasks.trigger("my-task", { data: "value" });

// Subscribe to specific run
for await (const run of runs.subscribeToRun<typeof myTask>(handle.id)) {
  console.log(`Status: ${run.status}, Progress: ${run.metadata?.progress}`);
  if (run.status === "COMPLETED") break;
}

// Subscribe to runs with tag
for await (const run of runs.subscribeToRunsWithTag("user-123")) {
  console.log(`Tagged run ${run.id}: ${run.status}`);
}

// Subscribe to batch
for await (const run of runs.subscribeToBatch(batchId)) {
  console.log(`Batch run ${run.id}: ${run.status}`);
}
```

### Realtime Streams v2

```ts
import { streams, InferStreamType } from "@trigger.dev/sdk";

// 1. Define streams (shared location)
export const aiStream = streams.define<string>({
  id: "ai-output",
});

export type AIStreamPart = InferStreamType<typeof aiStream>;

// 2. Pipe from task
export const streamingTask = task({
  id: "streaming-task",
  run: async (payload) => {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: payload.prompt }],
      stream: true,
    });

    const { waitUntilComplete } = aiStream.pipe(completion);
    await waitUntilComplete();
  },
});

// 3. Read from backend
const stream = await aiStream.read(runId, {
  timeoutInSeconds: 300,
  startIndex: 0, // Resume from specific chunk
});

for await (const chunk of stream) {
  console.log("Chunk:", chunk); // Fully typed
}
```

## Input Streams

Input streams let you send data **into** a running task from your backend or frontend. Output streams send data out of tasks; input streams complete the loop.

### Problems Input Streams Solve

**Cancelling AI streams mid-generation.** When you use AI SDK's `streamText` inside a task, the LLM keeps generating tokens until it's done — even if the user has navigated away or clicked "Stop generating." Without input streams, there's no way to tell the running task to abort. With input streams, your frontend sends a cancel signal and the task aborts the LLM call immediately.

**Human-in-the-loop workflows.** A task generates a draft, then pauses and waits for user approval before proceeding.

**Interactive agents.** An AI agent running as a task needs follow-up information from the user mid-execution.

### Defining Input Streams

```ts
// trigger/streams.ts
import { streams } from "@trigger.dev/sdk";

export const cancelSignal = streams.input<{ reason?: string }>({ id: "cancel" });
export const approval = streams.input<{ approved: boolean; reviewer: string }>({ id: "approval" });
```

### Receiving Data Inside a Task

#### `wait()` — Suspend until data arrives (recommended for long waits)

Suspends the task entirely, freeing compute. Returns `ManualWaitpointPromise<TData>` (same as `wait.forToken()`).

```ts
import { task } from "@trigger.dev/sdk";
import { approval } from "./streams";

export const publishPost = task({
  id: "publish-post",
  run: async (payload: { postId: string }) => {
    const draft = await prepareDraft(payload.postId);
    await notifyReviewer(draft);

    // Suspend — no compute cost while waiting
    const result = await approval.wait({ timeout: "7d" });

    if (result.ok) {
      return { published: result.output.approved };
    }
    return { published: false, timedOut: true };
  },
});
```

Options: `timeout` (period string), `idempotencyKey`, `idempotencyKeyTTL`, `tags`.

Use `.unwrap()` to throw on timeout: `const data = await approval.wait({ timeout: "24h" }).unwrap();`

**Use `.wait()` when:** nothing to do until data arrives, wait could be long, want zero compute cost.

#### `once()` — Wait for the next value (non-suspending)

Keeps the task process alive. Use for short waits or when doing concurrent work.

```ts
import { task } from "@trigger.dev/sdk";
import { approval } from "./streams";

export const draftEmailTask = task({
  id: "draft-email",
  run: async (payload: { to: string; subject: string }) => {
    const draft = await generateDraft(payload);
    const result = await approval.once(); // Blocks until data arrives

    if (result.approved) {
      await sendEmail(draft);
    }
    return { sent: result.approved, reviewer: result.reviewer };
  },
});
```

Options: `once({ timeoutMs: 300_000 })` or `once({ signal: controller.signal })`.

**Use `.once()` when:** wait is short, doing concurrent work, need AbortSignal support.

#### `on()` — Listen for every value

```ts
import { task } from "@trigger.dev/sdk";
import { cancelSignal } from "./streams";

export const streamingTask = task({
  id: "streaming-task",
  run: async (payload: { prompt: string }) => {
    const controller = new AbortController();

    const sub = cancelSignal.on(() => {
      controller.abort();
    });

    try {
      const result = await streamText({
        model: openai("gpt-4o"),
        prompt: payload.prompt,
        abortSignal: controller.signal,
      });
      return result;
    } finally {
      sub.off();
    }
  },
});
```

#### `peek()` — Non-blocking check

```ts
const latest = cancelSignal.peek(); // undefined if nothing received yet
```

### Sending Data to a Running Task

```ts
import { cancelSignal, approval } from "./trigger/streams";

await cancelSignal.send(runId, { reason: "User clicked stop" });
await approval.send(runId, { approved: true, reviewer: "alice@example.com" });
```

### Full Example: Cancellable AI Streaming

```ts
// trigger/streams.ts
import { streams } from "@trigger.dev/sdk";

export const aiOutput = streams.define<string>({ id: "ai" });
export const cancelStream = streams.input<{ reason?: string }>({ id: "cancel" });
```

```ts
// trigger/ai-task.ts
import { task } from "@trigger.dev/sdk";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { aiOutput, cancelStream } from "./streams";

export const aiTask = task({
  id: "ai-chat",
  run: async (payload: { prompt: string }) => {
    const controller = new AbortController();
    const sub = cancelStream.on(() => controller.abort());

    try {
      const result = streamText({
        model: openai("gpt-4o"),
        prompt: payload.prompt,
        abortSignal: controller.signal,
      });

      const { waitUntilComplete } = aiOutput.pipe(result.textStream);
      await waitUntilComplete();
      return { text: await result.text };
    } finally {
      sub.off();
    }
  },
});
```

### Important Notes

- Input streams require v2 realtime streams (SDK 4.1.0+). Calling `.on()` or `.once()` without v2 throws an error.
- Cannot send data to completed/failed/canceled runs.
- Max 1MB per `.send()` call.
- Data sent before a listener is registered gets buffered and delivered when a listener attaches.

## React Frontend Usage

### Installation

```bash
npm add @trigger.dev/react-hooks
```

### Triggering Tasks

```tsx
"use client";
import { useTaskTrigger, useRealtimeTaskTrigger } from "@trigger.dev/react-hooks";
import type { myTask } from "../trigger/tasks";

function TriggerComponent({ accessToken }: { accessToken: string }) {
  // Basic trigger
  const { submit, handle, isLoading } = useTaskTrigger<typeof myTask>("my-task", {
    accessToken,
  });

  // Trigger with realtime updates
  const {
    submit: realtimeSubmit,
    run,
    isLoading: isRealtimeLoading,
  } = useRealtimeTaskTrigger<typeof myTask>("my-task", { accessToken });

  return (
    <div>
      <button onClick={() => submit({ data: "value" })} disabled={isLoading}>
        Trigger Task
      </button>

      <button onClick={() => realtimeSubmit({ data: "realtime" })} disabled={isRealtimeLoading}>
        Trigger with Realtime
      </button>

      {run && <div>Status: {run.status}</div>}
    </div>
  );
}
```

### Subscribing to Runs

```tsx
"use client";
import { useRealtimeRun, useRealtimeRunsWithTag } from "@trigger.dev/react-hooks";
import type { myTask } from "../trigger/tasks";

function SubscribeComponent({ runId, accessToken }: { runId: string; accessToken: string }) {
  // Subscribe to specific run
  const { run, error } = useRealtimeRun<typeof myTask>(runId, {
    accessToken,
    onComplete: (run) => {
      console.log("Task completed:", run.output);
    },
  });

  // Subscribe to tagged runs
  const { runs } = useRealtimeRunsWithTag("user-123", { accessToken });

  if (error) return <div>Error: {error.message}</div>;
  if (!run) return <div>Loading...</div>;

  return (
    <div>
      <div>Status: {run.status}</div>
      <div>Progress: {run.metadata?.progress || 0}%</div>
      {run.output && <div>Result: {JSON.stringify(run.output)}</div>}

      <h3>Tagged Runs:</h3>
      {runs.map((r) => (
        <div key={r.id}>
          {r.id}: {r.status}
        </div>
      ))}
    </div>
  );
}
```

### Realtime Streams with React

```tsx
"use client";
import { useRealtimeStream } from "@trigger.dev/react-hooks";
import { aiStream } from "../trigger/streams";

function StreamComponent({ runId, accessToken }: { runId: string; accessToken: string }) {
  // Pass defined stream directly for type safety
  const { parts, error } = useRealtimeStream(aiStream, runId, {
    accessToken,
    timeoutInSeconds: 300,
    throttleInMs: 50, // Control re-render frequency
  });

  if (error) return <div>Error: {error.message}</div>;
  if (!parts) return <div>Loading...</div>;

  const text = parts.join(""); // parts is typed as AIStreamPart[]

  return <div>Streamed Text: {text}</div>;
}
```

### Wait Tokens

```tsx
"use client";
import { useWaitToken } from "@trigger.dev/react-hooks";

function WaitTokenComponent({ tokenId, accessToken }: { tokenId: string; accessToken: string }) {
  const { complete } = useWaitToken(tokenId, { accessToken });

  return <button onClick={() => complete({ approved: true })}>Approve Task</button>;
}
```

## Run Object Properties

Key properties available in run subscriptions:

- `id`: Unique run identifier
- `status`: `QUEUED`, `EXECUTING`, `COMPLETED`, `FAILED`, `CANCELED`, etc.
- `payload`: Task input data (typed)
- `output`: Task result (typed, when completed)
- `metadata`: Real-time updatable data
- `createdAt`, `updatedAt`: Timestamps
- `costInCents`: Execution cost

## Best Practices

- **Use Realtime over SWR**: Recommended for most use cases due to rate limits
- **Scope tokens properly**: Only grant necessary read/trigger permissions
- **Handle errors**: Always check for errors in hooks and subscriptions
- **Type safety**: Use task types for proper payload/output typing
- **Cleanup subscriptions**: Backend subscriptions auto-complete, frontend hooks auto-cleanup
- **Clean up input stream listeners**: Always call `.off()` in a `finally` block to avoid leaks
- **Use timeouts with `once()`**: Avoid hanging indefinitely if the signal never arrives
