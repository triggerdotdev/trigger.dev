---
"@trigger.dev/sdk": patch
---

Fixed a chat agent hanging after an interrupted turn: when a run was killed mid-answer (out of memory, crash, or eviction) and only the one message it was answering was still outstanding, the new run never replied to it. That message is now re-answered on the new run.
