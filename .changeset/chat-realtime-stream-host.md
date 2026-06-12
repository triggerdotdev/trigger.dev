---
"@trigger.dev/sdk": patch
---

Chat clients (`TriggerChatTransport` and `AgentChat`) now stream over Trigger.dev Cloud's dedicated realtime host (`realtime.trigger.dev`) by default. A chat session's long-lived SSE reads and input appends no longer run through the main Cloud API host, keeping chat streaming isolated from regular API traffic.

This only changes the Cloud default. Custom and self-hosted base URLs are left untouched (they keep serving realtime on the same origin), and passing a `baseURL` resolver function opts out entirely:

```ts
new TriggerChatTransport({
  task: "my-chat",
  // realtime in/out endpoints stay on your own host
  baseURL: ({ endpoint }) => "https://trigger.acme.internal",
});
```

If you gate chat traffic behind a CSP or network allowlist, add `realtime.trigger.dev`.
