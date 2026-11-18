---
"@trigger.dev/sdk": patch
---

Fix a `chat.agent` tool result containing a `BigInt` failing the next turn's model call in apps that define `BigInt.prototype.toJSON`. It is now sent as the JSON that `toJSON` gives, in the next step and in later turns.
