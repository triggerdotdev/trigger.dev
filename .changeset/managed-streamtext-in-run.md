---
"@trigger.dev/sdk": minor
---

`run()` now receives a `streamText` with your agent's managed options already applied, so they cannot be lost by leaving out the spread:

```ts
run: async ({ messages, signal, streamText }) =>
  streamText({ model, messages, abortSignal: signal });
```

Spreading `chat.toStreamTextOptions()` still works and is equivalent. The difference is what happens when your options collide with the managed ones. Passing `tools` after the spread replaces the skill tools, and passing your own `prepareStep` replaces the managed one, which silently switches off steering, compaction and injected context. The managed `streamText` merges tools and composes `prepareStep` instead, so neither can be turned off by accident.

`system` can be set at the call site, on `chat.agent({ system })`, or through `chat.prompt.set()`, but only in one of them: setting it in two places throws, because no single shape merges two system values across every supported AI SDK version, and dropping one silently is the failure this seam exists to prevent. Injected instructions append to whichever one is in play.

`chat.agent()` also takes `registry`, `cacheControl` and `systemProviderOptions` now, so a managed prompt's model and its cache breakpoint no longer have to be passed at the call site. `chat.toStreamTextOptions()` applies them as well, so spreading it into the `streamText` imported from `ai` stays equivalent to the one `run()` receives.

`chat.headStart` and `chat.startHeadStart` hand their `run` the same thing, carrying the options the handover protocol depends on. There it matters more: re-setting `messages`, `prompt`, `stopWhen` or `abortSignal` after a spread breaks the handover rather than degrading a feature, and nothing caught it. On the managed one those four keys are a type error; `tools` is yours to pass.
