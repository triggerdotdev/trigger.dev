import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { v3RunSpanPath } from "~/utils/pathBuilder";
import { eventRepository } from "~/v3/eventRepository.server";

const ParamsSchema = z.object({
  organizationSlug: z.string(),
  projectParam: z.string(),
  traceId: z.string(),
  spanId: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);

  const validatedParams = ParamsSchema.parse(params);

  const trace = await eventRepository.getTraceSummary(validatedParams.traceId);

  if (!trace) {
    return new Response("Not found", { status: 404 });
  }

  // Redirect to the project's runs page
  return redirect(
    v3RunSpanPath(
      { slug: validatedParams.organizationSlug },
      { slug: validatedParams.projectParam },
      { friendlyId: trace.rootSpan.runId },
      { spanId: validatedParams.spanId }
    )
  );
}
