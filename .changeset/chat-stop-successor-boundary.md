---
"@trigger.dev/sdk": patch
---

Keep new chat responses intact after Stop, including slow Stop acknowledgments and page reloads.
Sequence-free replies after Stop require a transcript reload before further messages.
Loading a fresh transcript through `useLoadTranscript` restores blocked sessions only after its saved input cursor covers the stopped turn.
