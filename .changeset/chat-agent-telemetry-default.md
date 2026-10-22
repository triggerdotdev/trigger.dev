---
"@trigger.dev/sdk": patch
---

The `streamText` passed to a `chat.agent`'s `run()` now turns AI SDK telemetry on by default, so each model step and tool call shows up as a span in the run trace even when the agent doesn't store a prompt with `chat.prompt.set()`. An agent with `telemetry: { recordUserMessage: false }` gets these spans without prompt and response content, including when it stores a prompt (whose variables are left out of the span metadata). Pass `experimental_telemetry: { isEnabled: false }` at the call site to turn them off, or `recordInputs: false` / `recordOutputs: false` to keep them without content.
