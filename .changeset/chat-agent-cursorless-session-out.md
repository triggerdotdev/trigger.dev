---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Fix `AgentChat` returning another turn's reply, or several replies joined together, instead of the answer to the message you sent: for example when continuing a chat without a saved `lastEventId`, sending two messages in a row, or when a run answers earlier messages first. Agents now mark where each turn starts and where steered messages join one on the output stream, so redeploy them on this version; with an older agent, a reply `AgentChat` can't match to your message is delivered when its turn completes instead of streamed. Custom readers of the session output stream must skip control records they don't recognise. A send aborted before its stream starts now asks the agent to stop.
