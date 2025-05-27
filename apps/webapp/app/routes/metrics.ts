import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { metricsRegister } from "~/metrics.server";

export async function loader({ request }: LoaderFunctionArgs) {
  // If the TRIGGER_METRICS_AUTH_PASSWORD is set, we need to check if the request has the correct password in auth header
  const authPassword = process.env.TRIGGER_METRICS_AUTH_PASSWORD;

  if (authPassword) {
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${authPassword}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const prismaMetrics = await prisma.$metrics.prometheus();
  const coreMetrics = await metricsRegister.metrics();

  return new Response(coreMetrics + prismaMetrics, {
    headers: {
      "Content-Type": metricsRegister.contentType,
    },
  });
}
