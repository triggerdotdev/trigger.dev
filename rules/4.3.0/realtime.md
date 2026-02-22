# Trigger.dev Realtime (v4)

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

### Realtime Streams v2 (Recommended)

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

Enable v2 by upgrading to 4.1.0 or later.

## Input Streams

Input streams let you send data **into** a running task from your backend or frontend. This enables bidirectional communication — output streams send data out of tasks, input streams complete the loop.

### Problems Input Streams Solve

**Cancelling AI streams mid-generation.** When you use AI SDK's `streamText` inside a task, the LLM keeps generating tokens until it's done — even if the user has navigated away or clicked "Stop generating." Without input streams, there's no way to tell the running task to abort. The task burns through tokens and compute for a response nobody will read. With input streams, your frontend sends a cancel signal and the task aborts the LLM call immediately.

**Human-in-the-loop workflows.** A task generates a draft email, then pauses and waits for the user to approve or edit it before sending. Input streams let the task block on `approval.once()` until the user responds.

**Interactive agents.** An AI agent running as a task needs follow-up information from the user mid-execution — clarifying a question, choosing between options, or providing additional context.

### Defining Input Streams

Define input streams in a shared file so both your task code and your backend/frontend can import them:

```ts
// trigger/streams.ts
import { streams } from "@trigger.dev/sdk";

// Typed input stream — the generic parameter defines the shape of data sent in
export const cancelSignal = streams.input<{ reason?: string }>({
  id: "cancel",
});

export const approval = streams.input<{ approved: boolean; reviewer: string }>({
  id: "approval",
});
```

### Receiving Data Inside a Task

#### `once()` — Wait for the next value

Blocks until data arrives. Useful for approval gates and one-shot signals.

```ts
import { task } from "@trigger.dev/sdk";
import { approval } from "./streams";

export const draftEmailTask = task({
  id: "draft-email",
  run: async (payload: { to: string; subject: string }) => {
    const draft = await generateDraft(payload);

    // Task pauses here until someone sends approval
    const result = await approval.once();

    if (result.approved) {
      await sendEmail(draft);
      return { sent: true, reviewer: result.reviewer };
    }

    return { sent: false, reviewer: result.reviewer };
  },
});
```

`once()` accepts options for timeouts and abort signals:

```ts
// With a timeout — rejects if no data arrives within 5 minutes
const result = await approval.once({ timeoutMs: 300_000 });

// With an abort signal
const controller = new AbortController();
const result = await approval.once({ signal: controller.signal });
```

#### `on()` — Listen for every value

Registers a persistent handler that fires on every piece of data. Returns a subscription with an `.off()` method.

```ts
import { task } from "@trigger.dev/sdk";
import { cancelSignal } from "./streams";

export const streamingTask = task({
  id: "streaming-task",
  run: async (payload: { prompt: string }) => {
    const controller = new AbortController();

    // Listen for cancel signals
    const sub = cancelSignal.on((data) => {
      console.log("Cancelled:", data.reason);
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
      sub.off(); // Clean up the listener
    }
  },
});
```

#### `peek()` — Non-blocking check

Returns the most recent buffered value without waiting, or `undefined` if nothing has been received yet.

```ts
const latest = cancelSignal.peek();
if (latest) {
  // A cancel was already sent before we checked
}
```

### Sending Data to a Running Task

Use `.send()` from your backend to push data into a running task:

```ts
import { cancelSignal, approval } from "./trigger/streams";

// Cancel a running AI stream
await cancelSignal.send(runId, { reason: "User clicked stop" });

// Approve a draft
await approval.send(runId, { approved: true, reviewer: "alice@example.com" });
```

### Cancelling AI SDK `streamText` Mid-Stream

This is the most common use case. Here's a complete example:

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

    // If the user cancels, abort the LLM call
    const sub = cancelStream.on(() => {
      controller.abort();
    });

    try {
      const result = streamText({
        model: openai("gpt-4o"),
        prompt: payload.prompt,
        abortSignal: controller.signal,
      });

      // Stream output to the frontend in real-time
      const { waitUntilComplete } = aiOutput.pipe(result.textStream);
      await waitUntilComplete();

      return { text: await result.text };
    } finally {
      sub.off();
    }
  },
});
```

```ts
// Backend: cancel from an API route
import { cancelStream } from "./trigger/streams";

export async function POST(req: Request) {
  const { runId } = await req.json();
  await cancelStream.send(runId, { reason: "User clicked stop" });
  return Response.json({ cancelled: true });
}
```

### Important Notes

- Input streams require v2 realtime streams (enabled by default in SDK 4.1.0+). If you're on an older version, calling `.on()` or `.once()` will throw with instructions to enable it.
- You cannot send data to a completed, failed, or canceled run.
- Maximum payload size per `.send()` call is 1MB.
- Data sent before any listener is registered is buffered and delivered when a listener attaches.
- Type safety is enforced through the generic parameter on `streams.input<T>()`.

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

### SWR Hooks (Fetch Once)

```tsx
"use client";
import { useRun } from "@trigger.dev/react-hooks";
import type { myTask } from "../trigger/tasks";

function SWRComponent({ runId, accessToken }: { runId: string; accessToken: string }) {
  const { run, error, isLoading } = useRun<typeof myTask>(runId, {
    accessToken,
    refreshInterval: 0, // Disable polling (recommended)
  });

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return <div>Run: {run?.status}</div>;
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
