---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Fixes a case where a chat could silently lose a message. If a message arrived while the agent was between turns and a stop arrived after it, the cursor the next boot resumed from could point past that message, so it was never answered and no error was raised. This affected `chat.agent`, not just custom agents.

Also fixes a retried send being answered twice. When a send was retried and its idempotency claim was lost, the agent could consume the same message a second time.

Custom agent loops can now inspect pending chat input without consuming it, and consume one mailbox record at a time, with `chat.messages.hasPending()` and `chat.messages.next()`. Records carry stable identifiers so a redelivery is recognisable.

```ts
if (await chat.messages.hasPending()) {
  const record = await chat.messages.next({ timeoutInSeconds: 0 });
  if (record) handle(record.payload);
}
```

A control record that nothing on the run consumes is now discarded rather than left at the head of the input channel, where it would have made every message queued behind it undeliverable. `chat.messages.next()` returning `undefined` means no message became consumable before the timeout.

`chat.writeTurnComplete()`'s `sessionInEventId` is the cursor that is safe to resume from, not the sequence of the record the turn answered. It is held back behind any message still waiting to be handled, so a value below the record you just handled is expected.
