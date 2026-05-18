---
"@trigger.dev/sdk": minor
---

**AI Prompts** — define prompt templates as code alongside your tasks, version them on deploy, and override the text or model from the dashboard without redeploying. Prompts integrate with the Vercel AI SDK via `toAISDKTelemetry()` (links every generation span back to the prompt) and with `chat.agent` via `chat.prompt.set()` + `chat.toStreamTextOptions()`.

```ts
import { prompts } from "@trigger.dev/sdk";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

export const supportPrompt = prompts.define({
  id: "customer-support",
  model: "gpt-4o",
  config: { temperature: 0.7 },
  variables: z.object({
    customerName: z.string(),
    plan: z.string(),
    issue: z.string(),
  }),
  content: `You are a support agent for Acme.

Customer: {{customerName}} ({{plan}} plan)
Issue: {{issue}}`,
});

const resolved = await supportPrompt.resolve({
  customerName: "Alice",
  plan: "Pro",
  issue: "Can't access billing",
});

const result = await generateText({
  model: openai(resolved.model ?? "gpt-4o"),
  system: resolved.text,
  prompt: "Can't access billing",
  ...resolved.toAISDKTelemetry(),
});
```

**What you get:**

- **Code-defined, deploy-versioned templates** — define with `prompts.define({ id, model, config, variables, content })`. Every deploy creates a new version visible in the dashboard. Mustache-style placeholders (`{{var}}`, `{{#cond}}...{{/cond}}`) with Zod / ArkType / Valibot-typed variables.
- **Dashboard overrides** — change a prompt's text or model from the dashboard without redeploying. Overrides take priority over the deployed "current" version and are environment-scoped (dev / staging / production independent).
- **Resolve API** — `prompt.resolve(vars, { version?, label? })` returns the compiled `text`, resolved `model`, `version`, and labels. Standalone `prompts.resolve<typeof handle>(slug, vars)` for cross-file resolution with full type inference on slug and variable shape.
- **AI SDK integration** — spread `resolved.toAISDKTelemetry({ ...extra })` into any `generateText` / `streamText` call and every generation span links to the prompt in the dashboard alongside its input variables, model, tokens, and cost.
- **`chat.agent` integration** — `chat.prompt.set(resolved)` stores the resolved prompt run-scoped; `chat.toStreamTextOptions({ registry })` pulls `system`, `model` (resolved via the AI SDK provider registry), `temperature` / `maxTokens` / etc., and telemetry into a single spread for `streamText`.
- **Management SDK** — `prompts.list()`, `prompts.versions(slug)`, `prompts.promote(slug, version)`, `prompts.createOverride(slug, body)`, `prompts.updateOverride(slug, body)`, `prompts.removeOverride(slug)`, `prompts.reactivateOverride(slug, version)`.
- **Dashboard** — prompts list with per-prompt usage sparklines; per-prompt detail with Template / Details / Versions / Generations / Metrics tabs. AI generation spans get a custom inspector showing the linked prompt's metadata, input variables, and template content alongside model, tokens, cost, and the message thread.

See [/docs/ai/prompts](https://trigger.dev/docs/ai/prompts) for the full reference — template syntax, version resolution order, override workflow, and type utilities (`PromptHandle`, `PromptIdentifier`, `PromptVariables`).
