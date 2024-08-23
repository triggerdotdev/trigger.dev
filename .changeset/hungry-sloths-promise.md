---
"trigger.dev": patch
"@trigger.dev/core": patch
---

Fix issues that could result in unreezable state run crashes. Details:
- Never checkpoint between attempts
- Some messages and socket data now include attempt numbers
- Remove attempt completion replays
- Additional prod entry point logging
- Fail runs that receive deprecated (pre-lazy attempt) execute messages
