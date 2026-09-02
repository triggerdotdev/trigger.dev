---
"@trigger.dev/build": patch
---

The `playwright` build extension now works with Playwright 1.58 and later. 1.58 changed the `playwright install --dry-run` output, which made deploy image builds fail while downloading the browsers.
