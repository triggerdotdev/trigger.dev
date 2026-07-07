---
"@trigger.dev/sdk": patch
---

Fix chat continuation runs replaying already-answered messages: turns delivered while the run was suspended now advance the session.in resume cursor, so a new run picks up exactly where the previous one left off.
