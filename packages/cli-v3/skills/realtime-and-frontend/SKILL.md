---
name: realtime-and-frontend
description: >
  Trigger.dev client/frontend surface: subscribe to runs in realtime
  (runs.subscribeToRun and the @trigger.dev/react-hooks hook useRealtimeRun),
  consume metadata and AI/text streams in React (useRealtimeStream), trigger
  tasks from the browser (useTaskTrigger, useRealtimeTaskTrigger), and mint
  scoped frontend credentials with auth.createPublicToken /
  auth.createTriggerPublicToken.
  Load when wiring a frontend (React/Next.js/Remix) or backend-for-frontend to
  show live run progress, status badges, token streams, trigger buttons, or
  wait-token approval UIs. NOT for writing the backend task itself (streams.define
  / metadata.set is authoring-tasks territory); this is the consumer side.
type: core
library: trigger.dev
library_version: "{{TRIGGER_SDK_VERSION}}"
sources:
  - docs/realtime/overview.mdx
  - docs/realtime/how-it-works.mdx
  - docs/realtime/auth.mdx
  - docs/realtime/run-object.mdx
  - docs/realtime/react-hooks/overview.mdx
  - docs/realtime/react-hooks/subscribe.mdx
  - docs/realtime/react-hooks/triggering.mdx
  - docs/realtime/react-hooks/streams.mdx
  - docs/realtime/react-hooks/swr.mdx
  - docs/realtime/react-hooks/use-wait-token.mdx
  - docs/realtime/backend/subscribe.mdx
---

# Realtime and Frontend

The consumer side of Trigger.dev's run state and streams: read live run
updates, render AI/text streams, and trigger tasks from a browser. Hooks come
from `@trigger.dev/react-hooks`; token minting and backend subscription come
from `@trigger.dev/sdk`.

## Setup

```bash
npm add @trigger.dev/react-hooks   # frontend hooks (React/Next.js/Remix)
# @trigger.dev/sdk is already installed for the backend
```

The flow is always: mint a scoped token in the backend, pass it to the
frontend, subscribe with a hook.

```ts
// backend (API route / server action)
import { auth } from "@trigger.dev/sdk";

const publicAccessToken = await auth.createPublicToken({
  scopes: { read: { runs: ["run_1234"] } }, // a token with no scopes is useless
});
```

```tsx
// frontend
"use client";
import { useRealtimeRun } from "@trigger.dev/react-hooks";

export function RunStatus({ runId, publicAccessToken }: { runId: string; publicAccessToken: string }) {
  const { run, error } = useRealtimeRun(runId, { accessToken: publicAccessToken });
  if (error) return <div>Error: {error.message}</div>;
  if (!run) return <div>Loading...</div>;
  return <div>Run: {run.status}</div>;
}
```

There are two token kinds: Public Access Tokens (read/subscribe, from
`auth.createPublicToken`) and Trigger Tokens (trigger-from-browser, single-use,
from `auth.createTriggerPublicToken`). Both default to a 15 minute expiry.

## Core patterns

### 1. Subscribe to a run and render metadata progress

`metadata` is `Record<string, DeserializedJson>`, so nested values need a cast.

```tsx
"use client";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import type { myTask } from "@/trigger/myTask";

export function Progress({ runId, publicAccessToken }: { runId: string; publicAccessToken: string }) {
  const { run, error } = useRealtimeRun<typeof myTask>(runId, { accessToken: publicAccessToken });
  if (error) return <div>Error: {error.message}</div>;
  if (!run) return <div>Loading...</div>;
  const progress = run.metadata?.progress as { percentage?: number } | undefined;
  return <div>{run.status}: {progress?.percentage ?? 0}%</div>;
}
```

Pass `onComplete: (run, error) => {}` to react when the run finishes.

### 2. Status-only subscription with `skipColumns`

For a badge or progress bar you do not need `payload`/`output`. Skipping them
reduces wire size and avoids "Large HTTP Payload" warnings.

```tsx
const { run } = useRealtimeRun(runId, {
  accessToken: publicAccessToken,
  skipColumns: ["payload", "output"],
});
```

You can skip any of: `payload`, `output`, `metadata`, `startedAt`, `delayUntil`,
`queuedAt`, `expiredAt`, `completedAt`, `number`, `isTest`, `usageDurationMs`,
`costInCents`, `baseCostInCents`, `ttl`, `payloadType`, `outputType`, `runTags`,
`error`.

### 3. Trigger from the browser with a Trigger Token

`accessToken` here is a Trigger Token (`auth.createTriggerPublicToken`), not a
Public Access Token.

```tsx
"use client";
import { useTaskTrigger } from "@trigger.dev/react-hooks";
import type { myTask } from "@/trigger/myTask";

export function TriggerButton({ publicAccessToken }: { publicAccessToken: string }) {
  const { submit, handle, isLoading } = useTaskTrigger<typeof myTask>("my-task", {
    accessToken: publicAccessToken,
  });
  if (handle) return <div>Run ID: {handle.id}</div>;
  return (
    <button onClick={() => submit({ foo: "bar" }, { tags: ["user:123"] })} disabled={isLoading}>
      {isLoading ? "Triggering..." : "Run"}
    </button>
  );
}
```

`submit(payload, options?)` takes the same options as a backend `trigger` call.

### 4. Trigger and subscribe in one hook

```tsx
"use client";
import { useRealtimeTaskTrigger } from "@trigger.dev/react-hooks";
import type { myTask } from "@/trigger/myTask";

export function Runner({ publicAccessToken }: { publicAccessToken: string }) {
  const { submit, run, isLoading } = useRealtimeTaskTrigger<typeof myTask>("my-task", {
    accessToken: publicAccessToken,
  });
  if (run) return <div>{run.status}</div>;
  return <button onClick={() => submit({ foo: "bar" })} disabled={isLoading}>Run</button>;
}
```

Use `useRealtimeTaskTriggerWithStreams<typeof myTask, STREAMS>` when you also
want the task's streams (it returns `{ submit, run, streams, error, isLoading }`).

### 5. Consume an AI/text stream (SDK 4.1.0+, recommended)

`useRealtimeStream` takes a defined stream for full type safety, or a `runId`
plus optional stream key. Returns `{ parts, error }`.

```tsx
"use client";
import { useRealtimeStream } from "@trigger.dev/react-hooks";
import { aiStream } from "@/trigger/streams"; // a defined stream -> typed parts

export function StreamView({ runId, publicAccessToken }: { runId: string; publicAccessToken: string }) {
  const { parts, error } = useRealtimeStream(aiStream, runId, {
    accessToken: publicAccessToken,
    timeoutInSeconds: 300, // default 60
    onData: (chunk) => console.log(chunk),
  });
  if (error) return <div>Error: {error.message}</div>;
  if (!parts) return <div>Loading...</div>;
  return <div>{parts.join("")}</div>;
}
```

Without a defined stream: `useRealtimeStream<string>(runId, "ai-output", { accessToken })`,
or omit the key to use the default stream. Other options: `baseURL`, `startIndex`,
`throttleInMs` (default 16). The legacy `useRealtimeRunWithStreams(runId, options)`
hook is still supported when you need both the run and all its streams at once.

### 6. Send input back into a running task

```tsx
"use client";
import { useInputStreamSend } from "@trigger.dev/react-hooks";
import { approval } from "@/trigger/streams";

export function ApprovalForm({ runId, accessToken }: { runId: string; accessToken: string }) {
  const { send, isLoading, isReady } = useInputStreamSend(approval.id, runId, { accessToken });
  return (
    <button disabled={!isReady || isLoading} onClick={() => send({ approved: true })}>
      Approve
    </button>
  );
}
```

### 7. Complete a wait token from React

```ts
// backend: create the token, return id + publicAccessToken to the frontend
import { wait } from "@trigger.dev/sdk";
const token = await wait.createToken({ timeout: "10m" });
return { tokenId: token.id, publicToken: token.publicAccessToken };
```

```tsx
"use client";
import { useWaitToken } from "@trigger.dev/react-hooks";

export function Approve({ tokenId, publicToken }: { tokenId: string; publicToken: string }) {
  const { complete } = useWaitToken(tokenId, { accessToken: publicToken });
  return <button onClick={() => complete({ approved: true })}>Approve</button>;
}
```

### 8. Subscribe from the backend (async iterators)

```ts
import { runs, tasks } from "@trigger.dev/sdk";
import type { myTask } from "./trigger/my-task";

const handle = await tasks.trigger("my-task", { some: "data" });
for await (const run of runs.subscribeToRun<typeof myTask>(handle.id)) {
  console.log(run.payload.some, run.output?.some); // typed
}
```

`runs.subscribeToRun` completes when the run finishes, so the loop exits on its own.

## Common mistakes

1. **CRITICAL: Triggering from the browser with a Public Access Token.** The
   read token from `createPublicToken` cannot trigger tasks.
   - Wrong: `useTaskTrigger("my-task", { accessToken: publicAccessTokenFromCreatePublicToken })`
   - Correct: mint a single-use Trigger Token with `auth.createTriggerPublicToken("my-task")` and pass that.

2. **Token with no scopes.** A scopeless token authorizes nothing, so every subscribe 403s.
   - Wrong: `await auth.createPublicToken()`
   - Correct: `await auth.createPublicToken({ scopes: { read: { runs: ["run_1234"] } } })`

3. **Polling with `useRun`/SWR for live updates.** `useRun` is the SWR-based
   management-API hook (not recommended for live state); set `refreshInterval: 0`
   to stop polling if you do use it.
   - Wrong: `useRun(runId, { refreshInterval: 1000 })` to track progress
   - Correct: `useRealtimeRun(runId, { accessToken })` (no polling, no WebSocket setup)

4. **Forgetting `"use client"`.** Realtime/trigger hooks cannot run in a server component.
   - Wrong: a Next.js App Router server component using `useRealtimeRun`
   - Correct: put `"use client";` at the top of any component using these hooks.

5. **Shipping `payload`/`output` you do not render.**
   - Wrong: `useRealtimeRun(runId, { accessToken })` for a status badge (large payloads over the wire)
   - Correct: `useRealtimeRun(runId, { accessToken, skipColumns: ["payload", "output"] })`

6. **Subscribing before the handle exists.**
   - Wrong: `useRealtimeRun(handle, { accessToken: handle?.publicAccessToken })` with no guard
   - Correct: add `enabled: !!handle` so it subscribes only once the trigger returns a handle.

## References

Sibling skills:
- `authoring-tasks` for the task side: `streams.define()`, `metadata.set()`, and `wait.createToken`.
- `authoring-chat-agent` and `chat-agent-advanced` for chat agents, which build on these realtime streams.

Docs:
- [React hooks: run updates](/realtime/react-hooks/subscribe)
- [React hooks: streaming](/realtime/react-hooks/streams)
- [Realtime auth](/realtime/auth)

The realtime run object differs from the management-API run object returned by
`useRun`; see [run object reference](/realtime/run-object). For the task side
(`streams.define`, `metadata.set`), see [/tasks/streams](/tasks/streams) and
[/runs/metadata](/runs/metadata).

## Version

Generated for @trigger.dev/sdk {{TRIGGER_SDK_VERSION}}. Re-run the trigger.dev skills installer after upgrading.
