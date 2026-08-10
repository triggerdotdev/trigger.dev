---
"trigger.dev": patch
---

Deployed images now install base system packages from a pinned Debian snapshot archive, making that layer byte-identical across projects and builds. Worker nodes running many projects cache one copy of it instead of a near-duplicate per project, speeding up image pulls. Set TRIGGER_BUILD_SKIP_APT_SNAPSHOT=1 to fall back to the live package archive.
