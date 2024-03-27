import { LoaderFunctionArgs } from "@remix-run/node";
import { basename } from "node:path";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { requireUserId } from "~/services/session.server";
import { r2 } from "~/v3/r2.server";

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

  if (!env.OBJECT_STORE_BASE_URL) {
    return new Response("Object store base URL is not set", { status: 500 });
  }

  if (!r2) {
    return new Response("Object store credentials are not set", { status: 500 });
  }

  const url = new URL(env.OBJECT_STORE_BASE_URL);
  url.pathname = `/packets/${environment.project.externalRef}/${environment.slug}/${filename}`;
  url.searchParams.set("X-Amz-Expires", "30"); // 30 seconds

  const signed = await r2.sign(
    new Request(url, {
      method: "GET",
    }),
    {
      aws: { signQuery: true },
    }
  );

  const response = await fetch(signed.url, {
    headers: signed.headers,
  });

  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${basename(url.pathname)}"`,
    },
  });
}
