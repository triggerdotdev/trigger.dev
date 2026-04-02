import { json } from "@remix-run/server-runtime";
import { PromptPresenter } from "~/presenters/v3/PromptPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactory.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    allowJWT: true,
    corsStrategy: "all",
    findResource: async () => 1,
    authorization: {
      action: "read",
      resource: () => ({ prompts: "all" }),
      superScopes: ["read:prompts", "admin"],
    },
  },
  async ({ authentication }) => {
    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(authentication.environment.organizationId, "standard");
    const presenter = new PromptPresenter(clickhouse);
    const prompts = await presenter.listPrompts(
      authentication.environment.projectId,
      authentication.environment.id
    );

    return json({
      data: prompts.map((p) => ({
        slug: p.slug,
        friendlyId: p.friendlyId,
        description: p.description,
        tags: p.tags,
        defaultModel: p.defaultModel,
        currentVersion: p.currentVersion?.version ?? null,
        hasOverride: p.hasOverride,
        updatedAt: p.updatedAt.toISOString(),
      })),
    });
  }
);
