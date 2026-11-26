---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
"trigger.dev": patch
---

Add `unstable_signals`: send a small message to every executing run in an environment that listens for its name, with `unstable_signals.send(name, payload)`, listen inside a task with `unstable_signals.on(name, handler)`, read the current latest once with `unstable_signals.latest(name)`, and forget the latest with `unstable_signals.clear(name)`. A run that starts listening receives the latest signal of that name first. Unstable: names and behavior may change.
