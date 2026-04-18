---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Add `setupLocals` option to `mockChatAgent` for dependency injection in tests. Pre-seed `locals` (database clients, service stubs) before the agent's `run()` starts, so hooks read the test instance via `locals.get()` without leaking through untrusted `clientData`. Also exposes `drivers.locals.set()` on `runInMockTaskContext`.
