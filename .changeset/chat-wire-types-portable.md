---
"@trigger.dev/sdk": patch
---

Fix TS2742 ("inferred type cannot be named") when exporting a `chat.agent` from a project with declaration emit: `ChatTaskWirePayload` and `ChatInputChunk` are now declared in the public `@trigger.dev/sdk/chat` subpath, so inferred agent types emit portable declarations and the wire types are directly importable.
