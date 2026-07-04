---
"@trigger.dev/core": patch
---

Change the run-ops run id format from a 27-char base62 KSUID to a 26-char lowercase base32hex id (ms timestamp + CSPRNG core, region char, version char) so run ids are DNS-1123 safe for Kubernetes pod names while staying lexicographically time-sortable
