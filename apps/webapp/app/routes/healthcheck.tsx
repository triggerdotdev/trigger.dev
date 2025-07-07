import { prisma } from "~/db.server";
import type { LoaderFunction } from "@remix-run/node";
import { env } from "~/env.server";

export const loader: LoaderFunction = async ({ request }) => {
  try {
    if (env.HEALTHCHECK_DATABASE_DISABLED === "1") {
      return new Response("OK");
    }

    await prisma.$queryRaw`SELECT 1`;
    return new Response("OK");
  } catch (error: unknown) {
    console.log("healthcheck ❌", { error });
    return new Response("ERROR", { status: 500 });
  }
};
