---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Fixes a case where a chat could silently lose a message. If a message arrived while the agent was between turns and a stop arrived after it, the cursor the next boot resumed from could point past that message, so it was never answered and no error was raised. This affected `chat.agent`, not just custom agents.

Fixes a recovered answer being cut off. After a crash the agent replays the message it had not answered yet, but it was replaying the stop that arrived after that message too, so the turn answering it was aborted the moment it began. A stop is now only applied to the turn that was live when it arrived. That holds however the stop got there: sent after the last completed turn, or sent to a chat whose most recent turn was completed by an older version of the SDK.

Also fixes a retried send being answered twice. When a send was retried and its idempotency claim was lost, the agent could consume the same message a second time.

Custom agent loops can now inspect pending chat input without consuming it, and consume one record at a time, with `chat.messages.hasPending()` and `chat.messages.next()`. Records carry stable identifiers so a redelivery is recognisable.

```ts
if (await chat.messages.hasPending()) {
  const record = await chat.messages.next({ timeoutInSeconds: 0 });
  if (record) handle(record.payload);
}
```

`hasPending()` answers for messages alone, so a message sitting behind a stop, or behind a record this version of the SDK does not recognise, still reports as pending and is still delivered. Anything the agent has no consumer for is discarded rather than left where it would make every message queued behind it undeliverable. `chat.messages.next()` returning `undefined` means no message became consumable before the timeout.

`chat.writeTurnComplete()`'s `sessionInEventId` is the cursor that is safe to resume from, not the sequence of the record the turn answered. It is held back behind any message still waiting to be handled, so a value below the record you just handled is expected.
