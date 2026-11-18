---
"@trigger.dev/sdk": patch
---

Fix `chat.agent` failing the next step or turn with `AI_InvalidPromptError` ("The messages do not match the ModelMessage[] schema") when a tool returned a value that isn't plain JSON, such as a `Date` from an ORM row. On AI SDK 6, and AI SDK 7 before 7.0.101, tool results are now converted to JSON the way newer AI SDK versions do it, so a `Date` reaches the model as its ISO string. A value JSON can't hold, such as a `BigInt` or a circular reference, is replaced by an error result that names the tool and the field, and the same error is logged on the run.
