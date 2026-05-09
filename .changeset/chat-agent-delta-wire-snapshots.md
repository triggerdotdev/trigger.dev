---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

`chat.agent` wire is now delta-only — clients ship at most one new message per `.in/append` instead of the full `UIMessage[]` history. The agent rebuilds prior history at run boot from a JSON snapshot in object storage plus a `wait=0` replay of the `session.out` tail. Long chats stop hitting the 512 KiB body cap on `/realtime/v1/sessions/{id}/in/append`. Snapshot writes happen after every `onTurnComplete`, awaited so they survive idle suspend; reads happen only at run boot. Registering a `hydrateMessages` hook short-circuits both the snapshot read/write and the replay — the customer is the source of truth for history.

Custom transports that constructed `ChatTaskWirePayload` directly need to drop the `messages: UIMessage[]` field and use `message?: UIMessage` (singular). Built-in transports (`TriggerChatTransport`, `AgentChat`) handle the change below the customer-facing surface — most apps need no changes. Configure object-store env vars (`OBJECT_STORE_*`) on your webapp deployment if you haven't already; without an object store and without `hydrateMessages`, conversations don't survive run boundaries.
