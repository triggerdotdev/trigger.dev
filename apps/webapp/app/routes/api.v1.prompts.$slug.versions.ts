import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { PromptPresenter } from "~/presenters/v3/PromptPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactory.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  slug: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
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
  async ({ resource: prompt }) => {
    if (!prompt) {
      return json({ error: "Prompt not found" }, { status: 404 });
    }

    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(prompt.project.organizationId, "standard");
    const presenter = new PromptPresenter(clickhouse);
    const versions = await presenter.listVersions(prompt.id);

    return json({
      data: versions.map((v) => ({
        id: v.id,
        version: v.version,
        labels: v.labels,
        source: v.source,
        model: v.model,
        textContent: v.textContent,
        commitMessage: v.commitMessage,
        contentHash: v.contentHash,
        createdAt: v.createdAt.toISOString(),
      })),
    });
  }
);
