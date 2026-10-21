---
"@trigger.dev/sdk": minor
"trigger.dev": minor
---

Route verified webhooks into agent sessions with `chat.event({ endpoint, key })`, and connect external chat surfaces with `chat.channels.custom({ endpoint })`. Both subscribe to a shared webhook endpoint, so an agent and your other webhook tasks can use the same provider URL. Channels support reply delivery, session binding, conversation seeding, and lifecycle reactions, and a failed turn posts a short line instead of the error (`errorMessage` sets it, as a string or a function of the failure). Use `chat.createWatchToken()` to watch a session from another surface.

A connector can also stream replies natively (`stream()`), mirror the session's state into the surface (`lifecycle()`), show tool calls as they run (`progress()`), stop a running turn from the surface (`onControl()`), post approvals and tool controls and resume the run from a verified click, download files only the surface can read (`download()`), and acknowledge or fold in messages that arrive mid-turn (`received()`, `pendingMessages`).
