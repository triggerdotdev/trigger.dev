---
"@trigger.dev/sdk": patch
---

Adds AI SDK 7 support. The `ai` peer range now includes v7, and the `chat.agent` / chat surfaces work against v7's ESM-only build. On v7, install `@ai-sdk/otel` alongside `ai` and the SDK registers it for you so `experimental_telemetry` spans keep flowing into your run traces (v7 stopped emitting them from `ai` core). v5 and v6 keep working unchanged.
