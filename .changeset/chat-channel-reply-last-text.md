---
"@trigger.dev/sdk": patch
---

A `chat.agent` channel's final reply is now the turn's last non-empty run of text (tool calls split the text into runs), instead of every step's text joined together. Notes the model wrote before its tool calls no longer end up in the posted reply, unless nothing follows the last tool call, in which case the text just before it is posted. `reply.message` still has every part.
