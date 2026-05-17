---
"@trigger.dev/build": minor
"references/libreoffice-convert": patch
---

feat(build): add `libreoffice()` build extension for docx/pptx to PDF conversion

Adds a `libreoffice(options?)` BuildExtension that installs LibreOffice system packages and `libreoffice-convert` npm package at deploy time, enabling direct Office-to-PDF conversion in Trigger.dev tasks.
