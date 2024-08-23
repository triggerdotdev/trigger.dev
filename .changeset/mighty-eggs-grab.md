---
"trigger.dev": patch
"@trigger.dev/core": patch
---

Tasks should now be much more robust and resilient to reconnects during crucial operations and other failure scenarios.

Task runs now have to signal checkpointable state prior to ALL checkpoints. This ensures flushing always happens.

All important socket.io RPCs will now be retried with backoff. Actions relying on checkpoints will be replayed if we haven't been checkpointed and restored as expected, e.g. after reconnect.

Other changes:

- Fix retry check in shared queue
- Fix env var sync spinner
- Heartbeat between retries
- Fix retry prep
- Fix prod worker no tasks detection
- Fail runs above `MAX_TASK_RUN_ATTEMPTS`
- Additional debug logs in all places
- Prevent crashes due to failed socket schema parsing
- Remove core-apps barrel
- Upgrade socket.io-client to fix an ACK memleak
- Additional index failure logs
- Prevent message loss during reconnect
- Prevent burst of heartbeats on reconnect
- Prevent crash on failed cleanup
- Handle at-least-once lazy execute message delivery
- Handle uncaught entry point exceptions
