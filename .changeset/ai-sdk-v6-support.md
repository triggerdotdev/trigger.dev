---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Add support for AI SDK v6 (Vercel AI SDK)

- Updated peer dependency to allow `ai@^6.0.0` alongside v4 and v5
- Updated internal code to handle async validation from AI SDK v6's Schema type
