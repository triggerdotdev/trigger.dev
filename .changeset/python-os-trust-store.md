---
"trigger.dev": patch
---

Python tasks and `pip` in deploy images now verify TLS against the image's trust store instead of a pinned certifi bundle, so they also refuse the compromised eMudhra intermediates.
