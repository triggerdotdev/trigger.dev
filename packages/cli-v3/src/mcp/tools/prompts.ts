import { z } from "zod";
import { toolsMetadata } from "../config.js";
import { CommonProjectsInput } from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const ListPromptsInput = CommonProjectsInput;

const PromptSlugInput = CommonProjectsInput.extend({
  slug: z.string().describe("The prompt slug"),
});

const PromoteInput = CommonProjectsInput.extend({
  slug: z.string().describe("The prompt slug"),
  version: z.number().int().positive().describe("The version number to promote to current"),
});

const CreateOverrideInput = CommonProjectsInput.extend({
  slug: z.string().describe("The prompt slug"),
  textContent: z.string().describe("The full text content for the override"),
  model: z.string().optional().describe("Optional model override"),
  commitMessage: z.string().optional().describe("Optional commit message describing the change"),
});

const UpdateOverrideInput = CommonProjectsInput.extend({
  slug: z.string().describe("The prompt slug"),
  textContent: z.string().optional().describe("Updated text content"),
  model: z.string().optional().describe("Updated model"),
  commitMessage: z.string().optional().describe("Commit message describing the change"),
});

const RemoveOverrideInput = PromptSlugInput;

const ReactivateOverrideInput = CommonProjectsInput.extend({
  slug: z.string().describe("The prompt slug"),
  version: z
    .number()
    .int()
    .positive()
    .describe("The dashboard-sourced version number to reactivate as override"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchPromptApi(
  apiClient: { fetchClient: typeof fetch; baseUrl: string },
  path: string,
  options?: RequestInit
) {
  const res = await apiClient.fetchClient(`${apiClient.baseUrl}/api/v1/prompts${path}`, options);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? `API error ${res.status}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

export const listPromptsTool = {
  name: toolsMetadata.list_prompts.name,
  title: toolsMetadata.list_prompts.title,
  description: toolsMetadata.list_prompts.description,
  inputSchema: ListPromptsInput.shape,
  handler: toolHandler(ListPromptsInput.shape, async (input, { ctx }) => {
    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:prompts"],
      branch: input.branch,
    });

    const result = await fetchPromptApi(apiClient, "");

    const prompts = result.data as Array<{
      slug: string;
      friendlyId: string;
      description?: string;
      defaultModel?: string;
      currentVersion: number | null;
      hasOverride: boolean;
      versionCount: number;
      tags: string[];
    }>;

    if (prompts.length === 0) {
      return { content: [{ type: "text" as const, text: "No prompts found." }] };
    }

    const lines = ["## Prompts\n"];
    for (const p of prompts) {
      const status = p.hasOverride ? " (override active)" : "";
      const version = p.currentVersion != null ? `v${p.currentVersion}` : "no current";
      lines.push(`- **${p.slug}** — ${version}${status} · ${p.versionCount} versions`);
      if (p.description) lines.push(`  ${p.description}`);
      if (p.defaultModel) lines.push(`  Model: ${p.defaultModel}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }),
};

export const getPromptVersionsTool = {
  name: toolsMetadata.get_prompt_versions.name,
  title: toolsMetadata.get_prompt_versions.title,
  description: toolsMetadata.get_prompt_versions.description,
  inputSchema: PromptSlugInput.shape,
  handler: toolHandler(PromptSlugInput.shape, async (input, { ctx }) => {
    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:prompts"],
      branch: input.branch,
    });

    const result = await fetchPromptApi(apiClient, `/${input.slug}/versions`);

    const versions = result.data as Array<{
      version: number;
      labels: string[];
      source: string;
      model?: string;
      textContent?: string;
      commitMessage?: string;
      createdAt: string;
    }>;

    if (versions.length === 0) {
      return { content: [{ type: "text" as const, text: "No versions found." }] };
    }

    const lines = [`## Versions for "${input.slug}"\n`];
    for (const v of versions) {
      const labels = v.labels.length > 0 ? ` [${v.labels.join(", ")}]` : "";
      const model = v.model ? ` · ${v.model}` : "";
      const msg = v.commitMessage ? ` — "${v.commitMessage}"` : "";
      lines.push(`- **v${v.version}**${labels} (${v.source})${model}${msg}`);
      if (v.textContent) {
        const preview =
          v.textContent.length > 120 ? v.textContent.slice(0, 120) + "..." : v.textContent;
        lines.push(`  Content: ${preview}`);
      }
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }),
};

// ---------------------------------------------------------------------------
// Write tools
// ---------------------------------------------------------------------------

export const promotePromptVersionTool = {
  name: toolsMetadata.promote_prompt_version.name,
  title: toolsMetadata.promote_prompt_version.title,
  description: toolsMetadata.promote_prompt_version.description,
  inputSchema: PromoteInput.shape,
  handler: toolHandler(PromoteInput.shape, async (input, { ctx }) => {
    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["admin"],
      branch: input.branch,
    });

    await fetchPromptApi(apiClient, `/${input.slug}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: input.version }),
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Promoted "${input.slug}" v${input.version} to current.`,
        },
      ],
    };
  }),
};

export const createPromptOverrideTool = {
  name: toolsMetadata.create_prompt_override.name,
  title: toolsMetadata.create_prompt_override.title,
  description: toolsMetadata.create_prompt_override.description,
  inputSchema: CreateOverrideInput.shape,
  handler: toolHandler(CreateOverrideInput.shape, async (input, { ctx }) => {
    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["admin"],
      branch: input.branch,
    });

    const result = await fetchPromptApi(apiClient, `/${input.slug}/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        textContent: input.textContent,
        model: input.model,
        commitMessage: input.commitMessage,
        source: "mcp",
      }),
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Created override for "${input.slug}" as v${result.version}.`,
        },
      ],
    };
  }),
};

export const updatePromptOverrideTool = {
  name: toolsMetadata.update_prompt_override.name,
  title: toolsMetadata.update_prompt_override.title,
  description: toolsMetadata.update_prompt_override.description,
  inputSchema: UpdateOverrideInput.shape,
  handler: toolHandler(UpdateOverrideInput.shape, async (input, { ctx }) => {
    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["admin"],
      branch: input.branch,
    });

    await fetchPromptApi(apiClient, `/${input.slug}/override`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        textContent: input.textContent,
        model: input.model,
        commitMessage: input.commitMessage,
      }),
    });

    return {
      content: [
        { type: "text" as const, text: `Updated override for "${input.slug}".` },
      ],
    };
  }),
};

export const removePromptOverrideTool = {
  name: toolsMetadata.remove_prompt_override.name,
  title: toolsMetadata.remove_prompt_override.title,
  description: toolsMetadata.remove_prompt_override.description,
  inputSchema: RemoveOverrideInput.shape,
  handler: toolHandler(RemoveOverrideInput.shape, async (input, { ctx }) => {
    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["admin"],
      branch: input.branch,
    });

    await fetchPromptApi(apiClient, `/${input.slug}/override`, {
      method: "DELETE",
    });

    return {
      content: [
        { type: "text" as const, text: `Removed override for "${input.slug}".` },
      ],
    };
  }),
};

export const reactivatePromptOverrideTool = {
  name: toolsMetadata.reactivate_prompt_override.name,
  title: toolsMetadata.reactivate_prompt_override.title,
  description: toolsMetadata.reactivate_prompt_override.description,
  inputSchema: ReactivateOverrideInput.shape,
  handler: toolHandler(ReactivateOverrideInput.shape, async (input, { ctx }) => {
    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["admin"],
      branch: input.branch,
    });

    await fetchPromptApi(apiClient, `/${input.slug}/override/reactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: input.version }),
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Reactivated v${input.version} as override for "${input.slug}".`,
        },
      ],
    };
  }),
};
