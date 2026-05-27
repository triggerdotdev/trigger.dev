# cf-trust-test worker

A minimal Cloudflare Worker that demonstrates the trusted-edge-signals pattern from [`docs/ai-chat/patterns/trusted-edge-signals`](../../../docs/ai-chat/patterns/trusted-edge-signals.mdx). The worker sits in front of the Trigger.dev API, intercepts the two body-write paths (`POST /api/v1/sessions` and `POST /realtime/v1/sessions/{id}/in/append`), and injects a server-trusted `__cf` namespace into the wire payload's `metadata` field. Everything else (SSE, auth, dashboard) passes through untouched.

Pairs with the `cfTrustTestAgent` (task id `cf-trust-test`) defined in `src/trigger/chat.ts`, which declares the `__cf` namespace in its `clientDataSchema` and echoes the values back so the round-trip is visible in the streamed response.

## Run it

```bash
# In references/ai-chat/cf-worker
pnpm install
pnpm run dev    # serves on http://localhost:8787, proxies to TRIGGER_API_UPSTREAM
```

Point the Next.js reference app at the worker by setting `TRIGGER_API_URL` and `NEXT_PUBLIC_TRIGGER_API_URL` to `http://localhost:8787` in `references/ai-chat/.env`. Then start trigger-dev and Next.js as usual.

`wrangler dev` populates `request.cf` with the developer's real Cloudflare edge metadata even in local mode; the worker falls back to hardcoded sample values if `request.cf` is unset.

## Wire-up for `.out` SSE direct (optional)

By default the reference app routes every request through `NEXT_PUBLIC_TRIGGER_API_URL`, so SSE also flows through the worker. To skip the worker on the long-lived `.out` channel — which gives no body-mutation benefit and adds one extra edge hop per reconnect — switch the transport's `baseURL` to the function form:

```ts
const transport = useTriggerChatTransport({
  // ...
  baseURL: ({ endpoint }) =>
    endpoint === "out"
      ? "https://api.trigger.dev"
      : process.env.NEXT_PUBLIC_TRIGGER_API_URL!,
});
```

See [`docs/ai-chat/patterns/trusted-edge-signals`](../../../docs/ai-chat/patterns/trusted-edge-signals.mdx) for the full design — threat model, agent-side schema, deploy considerations.
