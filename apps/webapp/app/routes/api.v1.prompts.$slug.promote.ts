import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { PromptService } from "~/v3/services/promptService.server";

const ParamsSchema = z.object({
  slug: z.string(),
});

const Body = z.object({
  version: z.number().int().positive(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: Body,
    method: "POST",
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "update",
      resource: (params) => ({ type: "prompts", id: params.slug }),
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

    const targetVersion = await prisma.promptVersion.findUnique({
      where: {
        promptId_version: {
          promptId: prompt.id,
          version: body.version,
        },
      },
    });

    if (!targetVersion) {
      return json({ error: `Version ${body.version} not found` }, { status: 404 });
    }

    try {
      const service = new PromptService();
      await service.promoteVersion(prompt.id, targetVersion.id, { sourceGuard: true });
    } catch (e) {
      if (e instanceof ServiceValidationError) {
        return json({ error: e.message }, { status: e.status ?? 400 });
      }
      throw e;
    }

    return json({ ok: true });
  }
);

export { action };
