import type { LoaderFunctionArgs } from "@remix-run/node";
import { basename } from "node:path";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { generatePresignedRequest } from "~/v3/objectStore.server";

const ParamSchema = z.object({
  environmentId: z.string(),
  "*": z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { environmentId, "*": filename } = ParamSchema.parse(params);

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: environmentId,
      organization: {
        members: {
          some: {
            userId,
          },
        },
      },
    },
    include: {
      project: true,
    },
  });

  if (!environment) {
    return new Response("Not found", { status: 404 });
  }

  const signed = await generatePresignedRequest(
    environment.project.externalRef,
    environment.slug,
    filename,
    "GET"
  );

  if (!signed.success) {
    return new Response(`Failed to generate presigned URL: ${signed.error}`, { status: 500 });
  }

  const response = await fetch(signed.request.url, {
    headers: signed.request.headers,
  });

  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    logger.warn("Packet download failed", { environmentId, status: response.status });
    return new Response(response.status === 404 ? "Not found" : "Failed to download packet", {
      status: response.status,
    });
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${basename(filename)}"`,
    },
  });
}
