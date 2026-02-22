# Input Stream `.wait()` — SDK Design

## Problem

The existing input stream methods (`.on()`, `.once()`, `.peek()`) are all **non-suspending**. When a task calls `await approval.once()`, the task process stays alive with an open SSE tail connection, consuming compute the entire time it waits for data.

This is fine for short-lived waits or cases where the task is doing other work concurrently (like streaming AI output while listening for a cancel signal). But for use cases where the task genuinely has nothing to do until data arrives — approval gates, human-in-the-loop decisions, waiting for external webhooks — keeping the process alive wastes compute and money.

`wait.forToken()` already solves this for arbitrary waitpoints: the task suspends, the process is freed, and execution resumes when the token is completed. Input stream `.wait()` brings that same suspension behavior to input streams, so you get the ergonomics of typed input streams with the efficiency of waitpoint-based suspension.

## API Surface

### `.wait()` method on input streams

```ts
const approval = streams.input<{ approved: boolean; reviewer: string }>({
  id: "approval",
});

// Inside a task — suspends execution until data arrives
const result = await approval.wait();
```

#### Signature

```ts
type RealtimeDefinedInputStream<TData> = {
  // ... existing methods ...

  /**
   * Suspend the task until data arrives on this input stream.
   *
   * Unlike `.once()` which keeps the task process alive while waiting,
   * `.wait()` suspends the task entirely — freeing compute resources.
   * The task resumes when data is sent via `.send()`.
   *
   * Uses a waitpoint token internally. Can only be called inside a task.run().
   */
  wait: (options?: InputStreamWaitOptions) => ManualWaitpointPromise<TData>;
};
```

#### Options

```ts
type InputStreamWaitOptions = {
  /**
   * Maximum time to wait before the waitpoint times out.
   * Uses the same period format as `wait.createToken()`.
   * If the timeout is reached, the result will be `{ ok: false, error }`.
   *
   * @example "30s", "5m", "1h", "24h", "7d"
   */
  timeout?: string;

  /**
   * Idempotency key for the underlying waitpoint token.
   * If the same key is used again (and hasn't expired), the existing
   * waitpoint is reused. This means if the task retries, it will
   * resume waiting on the same waitpoint rather than creating a new one.
   */
  idempotencyKey?: string;

  /**
   * TTL for the idempotency key. After this period, the same key
   * will create a new waitpoint.
   */
  idempotencyKeyTTL?: string;

  /**
   * Tags for the underlying waitpoint token, useful for querying
   * and filtering waitpoints via `wait.listTokens()`.
   */
  tags?: string[];
};
```

#### Return type

Returns `ManualWaitpointPromise<TData>` — the same type returned by `wait.forToken()`. This gives you two ways to handle the result:

**Check `ok` explicitly:**

```ts
const result = await approval.wait({ timeout: "24h" });

if (result.ok) {
  console.log(result.output.approved); // TData, fully typed
} else {
  console.log("Timed out:", result.error.message);
}
```

**Use `.unwrap()` to throw on timeout:**

```ts
// Throws WaitpointTimeoutError if the timeout is reached
const data = await approval.wait({ timeout: "24h" }).unwrap();
console.log(data.approved); // TData directly
```

## When to Use `.wait()` vs `.once()` vs `.on()`

| Method | Task suspended? | Compute cost while waiting | Best for |
|--------|----------------|---------------------------|----------|
| `.on(handler)` | No | Full — process stays alive | Continuous listening (cancel signals, live updates) |
| `.once()` | No | Full — process stays alive | Short waits, or when doing concurrent work |
| `.wait()` | **Yes** | **None** — process freed | Approval gates, human-in-the-loop, long waits |

### Use `.wait()` when:

- The task has **nothing else to do** until data arrives
- The wait could be **long** (minutes, hours, days) — e.g., waiting for a human to review something
- You want to **minimize compute cost** — the task suspends and doesn't burn resources
- You want **timeout behavior** matching `wait.forToken()` (auto-timeout with `ok: false`)
- You need **idempotency** for retries — the same idempotency key resumes the same wait

### Use `.once()` when:

- The wait is **short** (seconds) and suspending would add unnecessary overhead
- You're doing **concurrent work** while waiting — e.g., streaming AI output and waiting for the next user message at the same time
- You want **AbortSignal support** — `.once()` accepts a signal for cancellation from within the task
- You need to **check a buffer** — `.once()` resolves immediately if data was already sent before the call

### Use `.on()` when:

- You need to **react to every value**, not just the first one
- You're implementing **event-driven patterns** like cancel signals
- The handler runs **alongside other task work** (e.g., abort an AI stream when cancel arrives)

## Examples

### Approval gate — the core use case

The simplest case: a task does some work, then waits for human approval before continuing. With `.once()` this burns compute for the entire review period. With `.wait()` the task suspends.

```ts trigger/streams.ts
import { streams } from "@trigger.dev/sdk";

export const approval = streams.input<{
  approved: boolean;
  reviewer: string;
  comment?: string;
}>({ id: "approval" });
```

```ts trigger/publish-post.ts
import { task } from "@trigger.dev/sdk";
import { approval } from "./streams";

export const publishPost = task({
  id: "publish-post",
  run: async (payload: { postId: string }) => {
    const draft = await prepareDraft(payload.postId);

    // Notify reviewer (email, Slack, etc.)
    await notifyReviewer(draft);

    // Suspend until reviewer responds — no compute cost while waiting
    const result = await approval.wait({ timeout: "7d" }).unwrap();

    if (result.approved) {
      await publish(draft);
      return { published: true, reviewer: result.reviewer };
    }

    return { published: false, reason: result.comment };
  },
});
```

```ts app/api/review/route.ts
import { approval } from "@/trigger/streams";

export async function POST(req: Request) {
  const { runId, approved, comment } = await req.json();

  await approval.send(runId, {
    approved,
    reviewer: "alice@example.com",
    comment,
  });

  return Response.json({ ok: true });
}
```

### Idempotent waits for retries

If a task retries after a failure, you don't want to create a duplicate waitpoint. Use `idempotencyKey` to ensure the retry resumes the same wait.

```ts
export const processOrder = task({
  id: "process-order",
  retry: { maxAttempts: 3 },
  run: async (payload: { orderId: string }) => {
    await prepareOrder(payload.orderId);

    // Same idempotency key across retries — won't create duplicate waitpoints
    const result = await approval.wait({
      timeout: "48h",
      idempotencyKey: `order-approval-${payload.orderId}`,
      tags: [`order:${payload.orderId}`],
    });

    if (!result.ok) {
      throw new Error("Approval timed out after 48 hours");
    }

    await fulfillOrder(payload.orderId, result.output);
  },
});
```

### Multi-step conversation with an AI agent

An AI agent that pauses to ask the user for clarification. Each step suspends until the user responds.

```ts trigger/streams.ts
import { streams } from "@trigger.dev/sdk";

export const userMessage = streams.input<{
  text: string;
  attachments?: string[];
}>({ id: "user-message" });

export const agentOutput = streams.define<string>({ id: "agent" });
```

```ts trigger/agent.ts
import { task } from "@trigger.dev/sdk";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { userMessage, agentOutput } from "./streams";

export const agentTask = task({
  id: "ai-agent",
  run: async (payload: { initialPrompt: string }) => {
    const messages: Array<{ role: string; content: string }> = [
      { role: "user", content: payload.initialPrompt },
    ];

    for (let turn = 0; turn < 10; turn++) {
      // Generate a response
      const result = streamText({
        model: openai("gpt-4o"),
        messages,
      });

      const { waitUntilComplete } = agentOutput.pipe(result.textStream);
      await waitUntilComplete();

      const text = await result.text;
      messages.push({ role: "assistant", content: text });

      // Check if the agent wants to ask the user something
      if (!needsUserInput(text)) {
        break;
      }

      // Suspend and wait for the user to respond — zero compute cost
      const reply = await userMessage.wait({ timeout: "1h" }).unwrap();
      messages.push({ role: "user", content: reply.text });
    }

    return { messages };
  },
});
```

### Timeout handling

When a `.wait()` times out, you get `{ ok: false, error }` — just like `wait.forToken()`.

```ts
const result = await approval.wait({ timeout: "24h" });

if (!result.ok) {
  // WaitpointTimeoutError — the 24 hours elapsed
  await escalate(payload.ticketId);
  return { escalated: true };
}

// result.output is the typed data
await processApproval(result.output);
```

Or let it throw with `.unwrap()`:

```ts
try {
  const data = await approval.wait({ timeout: "24h" }).unwrap();
  await processApproval(data);
} catch (error) {
  if (error instanceof WaitpointTimeoutError) {
    await escalate(payload.ticketId);
  }
  throw error;
}
```

### Combining `.wait()` and `.on()` in the same task

A task that waits for structured user input (suspending) but also listens for a cancel signal (non-suspending) during the active work phases.

```ts trigger/streams.ts
import { streams } from "@trigger.dev/sdk";

export const cancelSignal = streams.input<{ reason?: string }>({ id: "cancel" });
export const userInput = streams.input<{ choice: "a" | "b" | "c" }>({ id: "user-input" });
```

```ts trigger/interactive-task.ts
import { task } from "@trigger.dev/sdk";
import { cancelSignal, userInput } from "./streams";

export const interactiveTask = task({
  id: "interactive",
  run: async (payload: { question: string }) => {
    // Phase 1: Suspend and wait for user choice (no compute cost)
    const { choice } = await userInput.wait({ timeout: "1h" }).unwrap();

    // Phase 2: Do expensive work with cancel support (compute is running)
    const controller = new AbortController();
    const sub = cancelSignal.on(() => controller.abort());

    try {
      const result = await doExpensiveWork(choice, controller.signal);
      return result;
    } finally {
      sub.off();
    }
  },
});
```

## Sending data — no changes

`.send()` works exactly the same whether the task is waiting via `.wait()`, `.once()`, or `.on()`. The caller doesn't need to know how the task is listening:

```ts
// This works regardless of whether the task used .wait(), .once(), or .on()
await approval.send(runId, { approved: true, reviewer: "alice" });
```

## Behavioral differences from `.once()`

| Behavior | `.once()` | `.wait()` |
|----------|-----------|-----------|
| Task process | Stays alive | Suspended |
| Buffered data | Resolves immediately from buffer | N/A — creates waitpoint before checking buffer |
| AbortSignal | Supported via `options.signal` | Not supported — use `timeout` instead |
| Timeout format | `timeoutMs` (milliseconds) | `timeout` (period string: `"24h"`, `"7d"`) |
| Timeout result | Rejects with `Error` | Resolves with `{ ok: false, error }` (or throws via `.unwrap()`) |
| Return type | `Promise<TData>` | `ManualWaitpointPromise<TData>` |
| Idempotency | None | Supported via `idempotencyKey` |
| Tags | None | Supported via `tags` |
| Multiple calls | Each `.once()` waits for the next value | Each `.wait()` creates a new waitpoint |
| Can use outside task | No (needs SSE tail) | No (needs `runtime.waitUntil()`) |

## How it works (conceptual)

Under the hood, `.wait()` bridges input streams with the waitpoint token system:

1. **Task calls `approval.wait()`** — creates a waitpoint token internally and tells the platform to link it to this input stream
2. **Task suspends** via `runtime.waitUntil(tokenId)` — process is freed, zero compute cost
3. **Caller sends data** via `approval.send(runId, data)` — the platform sees the linked waitpoint and completes it with the sent data
4. **Task resumes** — the waitpoint resolves and `.wait()` returns the typed data

The key insight is that the platform handles the bridging: it knows which waitpoint token is associated with which input stream, so when data arrives on the stream, it completes the corresponding waitpoint. The task doesn't need a running process to receive the data.
