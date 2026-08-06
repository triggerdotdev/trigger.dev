---
area: webapp
type: feature
---

Meet the dashboard agent: a chat in every environment that answers questions about your runs, queues, errors and health with real data and links. It takes over from Ask AI everywhere that used to appear; on the Free plan you get 20 messages.

**Investigate** on a failed run, an error, a backed-up queue or a run that hasn't started gets you a worked-through answer — what happened, why, and how to fix it, with every claim linked to the runs, errors and deploys behind it.

**Watch…** on a run, queue, error or the health report tells you when things change: a run finishes, a queue clears or grows past a number you pick, an error comes back, an environment recovers. The answer arrives in the chat and, if you want, by email, Slack or webhook — and the agent can look into bad news on its own.

The health report reads the same everywhere — dashboard, terminal, editor: same sections, same wording, and a marker instead of colour where colour isn't available. Its "stale data" mark is amber rather than blue, and its metric rows stay inside the panel when the chat is narrow. If a message to the agent fails, the chat says so and keeps saying so when you reopen it. A watch reaches you on any browser you sign in from, without opening the chat first — including one you started watching from another machine. A very long chat keeps working: the agent summarises the earlier part of the conversation and carries on, without losing an investigation or a watch that's still live. Messages to the agent now have a length limit, with a counter as you approach it. Setting up a watch leaves a record in the chat of exactly what you asked for, and submitting the same one twice never starts it twice. Unsubscribing from watch notifications takes effect immediately, and you can watch a run the moment you trigger it. An investigation that can't finish now closes itself in the chat instead of spinning forever, while the panel is still open and even if a write fails on the way. A watch says so when email couldn't be switched on, emails you once per result rather than twice, and tells you whether you will be emailed rather than whether anyone on the project will. The agent's replies no longer show images, and dashboard pages load images only from Trigger.dev and your sign-in provider; self-hosted deployments can name extra hosts.

A sample of conversations is scored automatically so the agent keeps getting better. Only the score and a one-line summary are kept, never your messages, data or code, and we can switch it off for your organization on request.

Separately: a queue's wait times, peak depth, throughput and throttling can now be read from the API, and the Docs button has been removed from page headers.
