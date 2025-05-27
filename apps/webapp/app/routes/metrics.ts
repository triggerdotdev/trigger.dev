import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { metricsRegister } from "~/metrics.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const prismaMetrics = await prisma.$metrics.prometheus();
  const coreMetrics = await metricsRegister.metrics();

  return new Response(coreMetrics + prismaMetrics, {
    headers: {
      "Content-Type": metricsRegister.contentType,
    },
  });
}
