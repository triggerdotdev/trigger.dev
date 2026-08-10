---
"trigger.dev": patch
---

Deployed images now install base system packages from a pinned Debian snapshot archive, so pushed images typically share one identical package layer across projects and builds instead of a near-duplicate per project, speeding up image pulls. Base package versions are frozen at the pinned snapshot date and move forward with CLI releases. Set TRIGGER_BUILD_SKIP_APT_SNAPSHOT=1 to fall back to the live package archive.
