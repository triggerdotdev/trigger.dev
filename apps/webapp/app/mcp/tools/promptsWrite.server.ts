import { prisma } from "~/db.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { PromptService } from "~/v3/services/promptService.server";
import type { McpToolContext, McpToolResult } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import { errorResult, textResult } from "./define.server";
import { defineWriteTool } from "./defineWrite.server";
import { subjectEnvironment } from "./query.server";
import {
  CreateOverrideInput,
  PromoteInput,
  PromptSlugInput,
  ReactivateOverrideInput,
  UpdateOverrideInput,
} from "./schemas/prompts";

async function withPrompt(
  ctx: McpToolContext,
  slug: string,
  fn: (prompt: { id: string }, service: PromptService) => Promise<McpToolResult>
): Promise<McpToolResult> {
  const environment = await subjectEnvironment(ctx);
  if (!environment) return errorResult("Environment not found");

  const prompt = await prisma.prompt.findFirst({
    where: { projectId: environment.projectId, runtimeEnvironmentId: environment.id, slug },
    select: { id: true },
  });
  if (!prompt) return errorResult("Prompt not found");

  try {
    return await fn(prompt, new PromptService());
  } catch (e) {
    if (e instanceof ServiceValidationError) return errorResult(e.message);
    throw e;
  }
}

async function withVersion(
  ctx: McpToolContext,
  slug: string,
  version: number,
  fn: (promptId: string, versionId: string, service: PromptService) => Promise<McpToolResult>
) {
  return withPrompt(ctx, slug, async (prompt, service) => {
    const target = await prisma.promptVersion.findFirst({
      where: { promptId: prompt.id, version },
      select: { id: true },
    });
    if (!target) return errorResult(`Version ${version} not found`);
    return fn(prompt.id, target.id, service);
  });
}

const auth = { action: "update", subject: "prompts" };

export const promptsWriteTools: McpToolDefinition[] = [
  defineWriteTool({
    name: "promote_prompt_version",
    title: "Promote Prompt Version",
    description:
      "Promote a prompt version to be the current active version. Only code-sourced versions can be promoted — dashboard overrides must use the override tools instead.",
    shape: PromoteInput.shape,
    approval: "configurable",
    auth,
    run: (input, ctx) =>
      withVersion(ctx, input.slug, input.version, async (promptId, versionId, service) => {
        await service.promoteVersion(promptId, versionId, { sourceGuard: true });
        return textResult(`Promoted "${input.slug}" v${input.version} to current.`);
      }),
  }),
  defineWriteTool({
    name: "create_prompt_override",
    title: "Create Prompt Override",
    description:
      "Create a dashboard override for a prompt. The override takes precedence over the current code version when resolving the prompt. Provide the full text content for the override.",
    shape: CreateOverrideInput.shape,
    approval: "configurable",
    auth,
    run: (input, ctx) =>
      withPrompt(ctx, input.slug, async (prompt, service) => {
        const result = await service.createOverride(prompt.id, {
          textContent: input.textContent,
          model: input.model,
          commitMessage: input.commitMessage,
          source: "mcp",
        });
        return textResult(`Created override for "${input.slug}" as v${result.version}.`);
      }),
  }),
  defineWriteTool({
    name: "update_prompt_override",
    title: "Update Prompt Override",
    description:
      "Update the active dashboard override for a prompt. Only works if an override is currently active.",
    shape: UpdateOverrideInput.shape,
    approval: "configurable",
    auth,
    run: (input, ctx) =>
      withPrompt(ctx, input.slug, async (prompt, service) => {
        await service.updateOverride(prompt.id, {
          textContent: input.textContent,
          model: input.model,
          commitMessage: input.commitMessage,
        });
        return textResult(`Updated override for "${input.slug}".`);
      }),
  }),
  defineWriteTool({
    name: "remove_prompt_override",
    title: "Remove Prompt Override",
    description:
      "Remove the active dashboard override for a prompt, reverting to the current code version.",
    shape: PromptSlugInput.shape,
    approval: "configurable",
    auth,
    run: (input, ctx) =>
      withPrompt(ctx, input.slug, async (prompt, service) => {
        await service.removeOverride(prompt.id);
        return textResult(`Removed override for "${input.slug}".`);
      }),
  }),
  defineWriteTool({
    name: "reactivate_prompt_override",
    title: "Reactivate Prompt Override",
    description:
      "Reactivate a previous dashboard-sourced version as the active override. Use get_prompt_versions to find dashboard versions that can be reactivated.",
    shape: ReactivateOverrideInput.shape,
    approval: "configurable",
    auth,
    run: (input, ctx) =>
      withVersion(ctx, input.slug, input.version, async (promptId, versionId, service) => {
        await service.reactivateOverride(promptId, versionId);
        return textResult(`Reactivated v${input.version} as override for "${input.slug}".`);
      }),
  }),
];
