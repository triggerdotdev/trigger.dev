---
"@trigger.dev/sdk": patch
---

`chat.headStart` now works with the `chat.customAgent` and `chat.createSession` backends, not only `chat.agent`. The warm step-1 response hands over to your loop the same way it does for a managed agent.

In a `chat.customAgent` loop, consume the handover on turn 0:

```ts
const conversation = new chat.MessageAccumulator();
const { isFinal, skipped } = await conversation.consumeHandover({ payload });
if (skipped) return; // warm handler aborted, so exit without a turn
if (isFinal) {
  await chat.writeTurnComplete(); // step 1 is the response, no streamText
} else {
  const result = streamText({ model, messages: conversation.modelMessages, tools });
  // Pass originalMessages so the handed-over tool round merges into the
  // step-1 assistant instead of starting a new message.
  const response = await chat.pipeAndCapture(result, {
    originalMessages: conversation.uiMessages,
  });
  if (response) await conversation.addResponse(response);
}
```

With `chat.createSession`, the iterator surfaces it as `turn.handover`; call `turn.complete()` with no argument on a final handover. The lower-level `chat.waitForHandover()` and `accumulator.applyHandover()` are also exported for hand-rolled loops.
