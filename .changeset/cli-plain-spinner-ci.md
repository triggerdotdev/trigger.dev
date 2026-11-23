---
"trigger.dev": patch
---

CLI spinners now print plain text lines in CI and when stdout is piped or redirected. Progress lines such as "Uploading deployment files" no longer start with a spinner frame or carry cursor escape codes, so `trigger deploy` logs in GitHub Actions and other CI systems read cleanly. Output in an interactive terminal is unchanged.
