---
"trigger.dev": patch
---

Add `--no-browser` flag to `init` and `login` to skip auto-opening the browser during authentication. Also error loudly when `init` is run without `--yes` under non-TTY stdin (previously default-and-exited silently, leaving the project half-initialized). Both commands now show an `Examples` section in `--help`.
