import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithFailure } from "~/services/apiAuth.server";
import { apiCors } from "~/utils/apiCors";
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

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return apiCors(request, json({}));
  }
  return apiCors(request, json({ error: "Method not allowed" }, { status: 405 }));
}

export async function action({ request, params }: ActionFunctionArgs) {
  const authResult = await authenticateApiRequestWithFailure(request, { allowJWT: true });
  if (!authResult) {
    return apiCors(request, json({ error: "Invalid or Missing API Key" }, { status: 401 }));
  }

  if (!authResult.ok) {
    return apiCors(request, json({ error: authResult.error }, { status: 401 }));
  }

  const { slug } = ParamsSchema.parse(params);

  const prompt = await prisma.prompt.findUnique({
    where: {
      projectId_runtimeEnvironmentId_slug: {
        projectId: authResult.environment.projectId,
        runtimeEnvironmentId: authResult.environment.id,
        slug,
      },
    },
  });

  if (!prompt) {
    return apiCors(request, json({ error: "Prompt not found" }, { status: 404 }));
  }

  const method = request.method.toUpperCase();
  const service = new PromptService();

  if (method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return apiCors(request, json({ error: "Invalid JSON" }, { status: 400 }));
    }
    const parsed = CreateBody.safeParse(rawBody);
    if (!parsed.success) {
      return apiCors(
        request,
        json({ error: "Invalid request body", issues: parsed.error.issues }, { status: 400 })
      );
    }

    const result = await service.createOverride(prompt.id, {
      textContent: parsed.data.textContent,
      model: parsed.data.model,
      commitMessage: parsed.data.commitMessage,
      source: parsed.data.source ?? "api",
    });

    return apiCors(request, json({ ok: true, version: result.version }));
  }

  if (method === "PUT" || method === "PATCH") {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return apiCors(request, json({ error: "Invalid JSON" }, { status: 400 }));
    }
    const parsed = UpdateBody.safeParse(rawBody);
    if (!parsed.success) {
      return apiCors(
        request,
        json({ error: "Invalid request body", issues: parsed.error.issues }, { status: 400 })
      );
    }

    try {
      await service.updateOverride(prompt.id, parsed.data);
    } catch (e) {
      if (e instanceof ServiceValidationError) {
        return apiCors(
          request,
          json({ error: e.message }, { status: e.status ?? 400 })
        );
      }
      throw e;
    }

    return apiCors(request, json({ ok: true }));
  }

  if (method === "DELETE") {
    await service.removeOverride(prompt.id);
    return apiCors(request, json({ ok: true }));
  }

  return apiCors(
    request,
    json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST, PUT, PATCH, DELETE" } })
  );
}
