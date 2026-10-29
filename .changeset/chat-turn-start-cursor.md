---
"@trigger.dev/sdk": patch
---

Fix reloading a chat mid-turn after its access token was refreshed. A token refresh during a streaming turn persisted a resume cursor from the middle of the turn, so a reload resumed past chunks the page needed and failed to rebuild the assistant message ("No tool invocation found for tool call ID"). The persisted cursor now stays at the start of the turn until it completes, so a reload replays the whole turn.
