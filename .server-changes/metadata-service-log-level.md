---
area: webapp
type: fix
---

Self-hosted instances no longer log run metadata activity at debug level regardless of the log level you configured, so logs are much quieter out of the box. Set `BATCH_METADATA_OPERATIONS_LOG_LEVEL=debug` if you want the detailed output back.
