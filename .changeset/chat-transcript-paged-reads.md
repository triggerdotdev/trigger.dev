---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Reading a page of a chat agent's conversation no longer downloads the whole conversation. The saved transcript now carries an index, so asking for the most recent messages fetches only those messages, and history loads in roughly constant time however long the chat gets.

A paged read also returns only the conversation itself. The model-side context an agent keeps, its compacted history and any injected context, is no longer included, so it cannot reach a browser through a load-transcript server action.

The built-in storage is deliberately basic about long conversations: once an agent has compacted, it keeps roughly the last hundred messages and drops the rest, so what it rewrites each turn stops growing. A conversation that never compacts is kept whole. If your app renders history further back than that, give the agent your own transcript storage.

The saved format has changed and an older SDK cannot read it, so a deployment rolled back to an earlier version will not find a readable transcript for conversations the newer version already saved, and those conversations continue from the live stream tail instead. Roll forward rather than back, or keep your own transcript storage.
