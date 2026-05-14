---
"@trigger.dev/core": patch
---

Add optional `notice` field to `TriggerTaskResponse` for mollifier transparency. When the platform's burst-buffer accepts a trigger, the response carries a structured `{ code, message, docs }` notice so SDKs and customers can surface guidance (e.g. recommending `batchTrigger` for large fan-outs) without the trigger appearing to fail.
