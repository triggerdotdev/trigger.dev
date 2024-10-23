---
"trigger.dev": patch
"@trigger.dev/core": patch
---

- Include retries.default in task retry config when indexing
- New helpers for internal error retry mechanics
- Detection for segfaults and ffmpeg OOM errors
- Retries for packet import and export