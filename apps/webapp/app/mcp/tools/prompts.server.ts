import { $replica } from "~/db.server";
import { PromptPresenter } from "~/presenters/v3/PromptPresenter.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, textResult } from "./define.server";
import { subjectEnvironment } from "./query.server";
import { ListPromptsInput, PromptSlugInput } from "./schemas/prompts";

// The listing methods only read Postgres, so no ClickHouse client is needed.
const presenter = () => new PromptPresenter(undefined as never, $replica);
const fence = (text: string) => fenceUntrusted(text, "prompt");

export const promptsTools: McpToolDefinition[] = [
  defineReadTool({
    name: "list_prompts",
    title: "List Prompts",
    description:
      "List all managed prompts in the project environment. Shows slug, current version, override status, and version count.",
    shape: ListPromptsInput.shape,
    auth: { action: "read", subject: "prompts" },
    run: async (_input, ctx) => {
      const environment = await subjectEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      const prompts = await presenter().listPrompts(environment.projectId, environment.id);

      if (prompts.length === 0) return textResult("No prompts found.");

      const lines = ["## Prompts\n"];
      for (const p of prompts) {
        const status = p.hasOverride ? " (override active)" : "";
        const version = p.currentVersion ? `v${p.currentVersion.version}` : "no current";
        lines.push(`- **${fence(p.slug)}** — ${version}${status}`);
        if (p.description) lines.push(`  ${fence(p.description)}`);
        if (p.defaultModel) lines.push(`  Model: ${fence(p.defaultModel)}`);
      }

      return textResult(lines.join("\n"));
    },
  }),
  defineReadTool({
    name: "get_prompt_versions",
    title: "Get Prompt Versions",
    description:
      "List all versions for a specific prompt. Shows version number, labels (current, override, latest), source (code or dashboard), model, and content.",
    shape: PromptSlugInput.shape,
    auth: { action: "read", subject: "prompts" },
    run: async (input, ctx) => {
      const environment = await subjectEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      const prompt = await $replica.prompt.findFirst({
        where: {
          projectId: environment.projectId,
          runtimeEnvironmentId: environment.id,
          slug: input.slug,
        },
        select: { id: true },
      });
      if (!prompt) return errorResult("Prompt not found");

      const versions = await presenter().listVersions(prompt.id);

      if (versions.length === 0) return textResult("No versions found.");

      const lines = [`## Versions for ${fence(input.slug)}\n`];
      for (const v of versions) {
        const labels = v.labels.length > 0 ? ` [${v.labels.join(", ")}]` : "";
        const model = v.model ? ` · ${fence(v.model)}` : "";
        const msg = v.commitMessage ? ` — ${fence(v.commitMessage)}` : "";
        lines.push(`- **v${v.version}**${labels} (${v.source})${model}${msg}`);
        if (v.textContent) {
          const preview =
            v.textContent.length > 120 ? v.textContent.slice(0, 120) + "..." : v.textContent;
          lines.push(`  Content: ${fence(preview)}`);
        }
      }

      return textResult(lines.join("\n"));
    },
  }),
];
