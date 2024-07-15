import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { metricsRegister } from "~/metrics.server";

export async function loader({ request }: LoaderFunctionArgs) {
  return new Response(await metricsRegister.metrics(), {
    headers: {
      "Content-Type": metricsRegister.contentType,
    },
  });
}
