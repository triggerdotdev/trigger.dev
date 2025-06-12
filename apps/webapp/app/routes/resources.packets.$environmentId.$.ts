import { LoaderFunctionArgs } from "@remix-run/node";
import { basename } from "node:path";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { generatePresignedRequest } from "~/v3/r2.server";

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

  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${basename(filename)}"`,
    },
  });
}
