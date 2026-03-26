import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { PromptPresenter } from "~/presenters/v3/PromptPresenter.server";
import { getClickhouseForOrganization } from "~/services/clickhouse/clickhouseFactory.server";
import {
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  slug: z.string(),
});

const SearchParams = z.object({
  label: z.string().optional(),
  version: z.coerce.number().optional(),
});

// GET /api/v1/prompts/:slug — Get prompt + version
export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    searchParams: SearchParams,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, authentication) => {
      return prisma.prompt.findUnique({
        where: {
          projectId_runtimeEnvironmentId_slug: {
            projectId: authentication.environment.projectId,
            runtimeEnvironmentId: authentication.environment.id,
            slug: params.slug,
          },
        },
        include: {
          project: {
            select: {
              organizationId: true,
            },
          },
        },
      });
    },
    authorization: {
      action: "read",
      resource: (_resource, params) => ({ prompts: params.slug }),
      superScopes: ["read:prompts", "admin"],
    },
  },
  async ({ searchParams, resource: prompt }) => {
    if (!prompt) {
      return json({ error: "Prompt not found" }, { status: 404 });
    }

    const clickhouse = await getClickhouseForOrganization(prompt.project.organizationId, "standard");
    const presenter = new PromptPresenter(clickhouse);
    const version = await presenter.resolveVersion(prompt.id, {
      version: searchParams.version,
      label: searchParams.label,
    });

    if (!version) {
      return json({ error: "No version found" }, { status: 404 });
    }

    return json({
      data: {
        id: prompt.friendlyId,
        slug: prompt.slug,
        description: prompt.description,
        type: prompt.type,
        tags: prompt.tags,
        defaultModel: prompt.defaultModel,
        defaultConfig: prompt.defaultConfig,
        variableSchema: prompt.variableSchema,
        version: {
          version: version.version,
          textContent: version.textContent,
          model: version.model,
          config: version.config,
          source: version.source,
          labels: version.labels,
          contentHash: version.contentHash,
          commitMessage: version.commitMessage,
          createdAt: version.createdAt,
        },
      },
    });
  }
);

// POST /api/v1/prompts/:slug — Resolve prompt with variables

const ResolveBody = z.object({
  variables: z.record(z.unknown()).default({}),
  label: z.string().optional(),
  version: z.number().optional(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: ResolveBody,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: (params) => ({ prompts: params.slug }),
      superScopes: ["read:prompts", "admin"],
    },
  },
  async ({ body, params, authentication }) => {
    const prompt = await prisma.prompt.findUnique({
      where: {
        projectId_runtimeEnvironmentId_slug: {
          projectId: authentication.environment.projectId,
          runtimeEnvironmentId: authentication.environment.id,
          slug: params.slug,
        },
      },
    });

    if (!prompt) {
      return json({ error: "Prompt not found" }, { status: 404 });
    }

    const clickhouse = await getClickhouseForOrganization(authentication.environment.organizationId, "standard");
    const presenter = new PromptPresenter(clickhouse);
    const version = await presenter.resolveVersion(prompt.id, {
      version: body.version,
      label: body.label,
    });

    if (!version) {
      return json({ error: "No version found" }, { status: 404 });
    }

    if (!version.textContent) {
      return json({ error: "Prompt has no content" }, { status: 404 });
    }

    const text = compileTemplate(version.textContent, body.variables);
    return json({
      data: {
        promptId: prompt.friendlyId,
        slug: prompt.slug,
        version: version.version,
        labels: version.labels,
        template: version.textContent,
        text,
        model: version.model ?? prompt.defaultModel,
        config: version.config ?? prompt.defaultConfig,
      },
    });
  }
);

export { action };

function compileTemplate(
  template: string,
  variables: Record<string, unknown>
): string {
  let result = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key, content) => {
      const value = variables[key];
      return value
        ? content.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => {
            return String(variables[k] ?? "");
          })
        : "";
    }
  );

  result = result.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
    const value = variables[key];
    return value !== undefined && value !== null ? String(value) : "";
  });

  return result;
}
