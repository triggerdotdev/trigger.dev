import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { metricsRegister } from "~/metrics.server";
import { logger } from "~/services/logger.server";

export async function loader({ request }: LoaderFunctionArgs) {
  logger.debug("Getting metrics from the metrics register");

  return new Response(await metricsRegister.metrics(), {
    headers: {
      "Content-Type": metricsRegister.contentType,
    },
  });
}
