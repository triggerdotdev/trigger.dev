---
"@trigger.dev/sdk": patch
---

`chat.headStart` now accepts an `apiClient` option (base URL + access token), so the head-start route can create the session and trigger the agent run against a different project/environment than the warm server's ambient Trigger config. Useful when your `chat.agent` lives in a separate project from the app serving the route. Mirrors the `apiClient` option on `chat.createStartSessionAction`; your LLM provider keys stay in the `run` callback and are unaffected.

```ts
export const POST = chat.headStart({
  agentId: "my-agent",
  apiClient: { baseURL, accessToken },
  run: async ({ chat }) =>
    streamText({ ...chat.toStreamTextOptions({ tools }), model: anthropic("claude-sonnet-4-6") }),
});
```
