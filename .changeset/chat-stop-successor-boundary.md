---
"@trigger.dev/sdk": patch
---

Keep new chat responses intact after Stop, including slow Stop acknowledgments and page reloads.
Stop on an idle hydrated session no longer discards the next response. Early resumed Stop retains its protection.

Stop also protects messages and actions that still await an input acknowledgment.
Canceled messages and actions do not append after session creation or token renewal.
Stop retains token renewal but does not recreate a missing session after HTTP 404.

`stopGeneration(chatId, { throwOnError: true })` reports delivery failures with the original error and HTTP status.
Without this option, delivery failures still return `false`. A missing local session returns `false` in both modes.
The local reader stays closed after a delivery failure. The remote run can continue.

Sequence-free replies after Stop require a transcript reload before further messages.
Concurrent sends also respect this recovery requirement.
Loading a fresh transcript through `useLoadTranscript` restores blocked sessions only after its saved input cursor covers the stopped turn.
Transcript recovery reports missing cursor evidence and empty output polls. An empty recovery poll keeps the accepted message available for reconnect.
