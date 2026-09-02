---
"@trigger.dev/build": patch
---

Fix the `playwright` build extension for Playwright 1.58+. The extension reads `playwright install --dry-run` to find each browser's download URL, and 1.58 changed the per-browser header from `browser: chromium-headless-shell version …` to `Chrome Headless Shell … (playwright chromium-headless-shell v…)`, so the image build failed at the `grep` step with exit code 1. The header match now accepts both formats, and the context window after the header is narrowed to the two lines actually used (install location and download url): 1.58+ blocks are shorter than before, so the old window ran into the next browser's install location and would have extracted the archive into the wrong directory.
