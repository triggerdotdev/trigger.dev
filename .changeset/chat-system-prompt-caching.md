---
"@trigger.dev/sdk": patch
---

Cache your chat agent's system prompt with Anthropic prompt caching. `chat.toStreamTextOptions()` now emits the system prompt as a cacheable message when you opt in, so a large, stable system block is billed at cache-read rates on every turn instead of full price.

```ts
// at the streamText call site (Anthropic sugar)
streamText({
  ...chat.toStreamTextOptions({ cacheControl: { type: "ephemeral" } }),
  messages,
});

// provider-agnostic equivalent
chat.toStreamTextOptions({
  systemProviderOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
});

// or where the prompt is defined
chat.prompt.set(SYSTEM_PROMPT, {
  providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
});
```

Without an option, `system` stays a plain string. Pairs with a `prepareMessages` cache breakpoint to cache the conversation prefix across turns too.
