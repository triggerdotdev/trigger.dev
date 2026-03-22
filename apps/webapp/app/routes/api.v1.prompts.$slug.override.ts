import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createMultiMethodApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { PromptService } from "~/v3/services/promptService.server";

const ParamsSchema = z.object({
  slug: z.string(),
});

const CreateBody = z.object({
  textContent: z.string(),
  model: z.string().optional(),
  commitMessage: z.string().optional(),
  source: z.string().optional(),
});

const UpdateBody = z.object({
  textContent: z.string().optional(),
  model: z.string().optional(),
  commitMessage: z.string().optional(),
});

async function findPrompt(slug: string, authentication: { environment: { projectId: string; id: string } }) {
  return prisma.prompt.findUnique({
    where: {
      projectId_runtimeEnvironmentId_slug: {
        projectId: authentication.environment.projectId,
        runtimeEnvironmentId: authentication.environment.id,
        slug,
      },
    },
  });
}

const { action, loader } = createMultiMethodApiRoute({
  params: ParamsSchema,
  allowJWT: true,
  corsStrategy: "all",
  authorization: {
    action: "update",
    resource: (params) => ({ prompts: params.slug }),
    superScopes: ["admin"],
  },
  methods: {
    POST: {
      body: CreateBody,
      handler: async ({ params, body, authentication }) => {
        const prompt = await findPrompt(params.slug, authentication);
        if (!prompt) return json({ error: "Prompt not found" }, { status: 404 });

        const service = new PromptService();
        const result = await service.createOverride(prompt.id, {
          textContent: body.textContent,
          model: body.model,
          commitMessage: body.commitMessage,
          source: body.source ?? "api",
        });

        return json({ ok: true, version: result.version });
      },
    },
    PUT: {
      body: UpdateBody,
      handler: async ({ params, body, authentication }) => {
        const prompt = await findPrompt(params.slug, authentication);
        if (!prompt) return json({ error: "Prompt not found" }, { status: 404 });

        try {
          const service = new PromptService();
          await service.updateOverride(prompt.id, body);
        } catch (e) {
          if (e instanceof ServiceValidationError) {
            return json({ error: e.message }, { status: e.status ?? 400 });
          }
          throw e;
        }

        return json({ ok: true });
      },
    },
    PATCH: {
      body: UpdateBody,
      handler: async ({ params, body, authentication }) => {
        const prompt = await findPrompt(params.slug, authentication);
        if (!prompt) return json({ error: "Prompt not found" }, { status: 404 });

        try {
          const service = new PromptService();
          await service.updateOverride(prompt.id, body);
        } catch (e) {
          if (e instanceof ServiceValidationError) {
            return json({ error: e.message }, { status: e.status ?? 400 });
          }
          throw e;
        }

        return json({ ok: true });
      },
    },
    DELETE: {
      handler: async ({ params, authentication }) => {
        const prompt = await findPrompt(params.slug, authentication);
        if (!prompt) return json({ error: "Prompt not found" }, { status: 404 });

        const service = new PromptService();
        await service.removeOverride(prompt.id);
        return json({ ok: true });
      },
    },
  },
});

export { action, loader };
