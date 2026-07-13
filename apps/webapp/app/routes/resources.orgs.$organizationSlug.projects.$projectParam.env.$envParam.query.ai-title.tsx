import { openai } from "@ai-sdk/openai";
import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { aiTitleRateLimiter } from "~/v3/services/aiTitleRateLimiter.server";
import { AIQueryTitleService } from "~/v3/services/aiQueryTitleService.server";

// `/resources/*` isn't covered by the global apiRateLimiter (`/api/*` only),
// so this endpoint needs its own per-route limiter and length cap.
const MAX_QUERY_LENGTH = 10_000;

const RequestSchema = z.object({
  query: z.string().min(1, "Query is required").max(MAX_QUERY_LENGTH),
  queryId: z.string().optional(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const limit = await aiTitleRateLimiter.limit(`user:${userId}`);
  if (!limit.success) {
    return json(
      {
        success: false as const,
        error: "Too many requests — please wait a moment and try again.",
        title: null,
      },
      { status: 429 }
    );
  }

  // Parse the request body
  const [error, data] = await tryCatch(request.json());
  if (error) {
    return json({ success: false as const, error: error.message, title: null }, { status: 400 });
  }
  const submission = RequestSchema.safeParse(data);

  if (!submission.success) {
    return json(
      { success: false as const, error: "Invalid request data", title: null },
      { status: 400 }
    );
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return json(
      { success: false as const, error: "Project not found", title: null },
      { status: 404 }
    );
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return json(
      { success: false as const, error: "Environment not found", title: null },
      { status: 404 }
    );
  }

  if (!env.OPENAI_API_KEY) {
    return json(
      { success: false as const, error: "OpenAI API key is not configured", title: null },
      { status: 400 }
    );
  }

  const { query, queryId } = submission.data;

  const service = new AIQueryTitleService(openai(env.AI_RUN_FILTER_MODEL ?? "gpt-4o-mini"));

  const result = await service.generateTitle(query);

  if (!result.success) {
    return json({ success: false as const, error: result.error, title: null }, { status: 500 });
  }

  // Strip leading/trailing quotes that AI sometimes adds
  const title = result.title.replace(/^["']|["']$/g, "");

  // If a queryId was provided, update the CustomerQuery record with the title
  if (queryId) {
    await prisma.customerQuery.update({
      where: { id: queryId, organizationId: project.organizationId },
      data: { title },
    });
  }

  return json({ success: true as const, title, error: null });
}
