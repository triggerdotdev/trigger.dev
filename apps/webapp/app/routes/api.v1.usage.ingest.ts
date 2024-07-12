import { type ActionFunctionArgs } from "@remix-run/server-runtime";
import { logger } from "~/services/logger.server";
import { reportComputeUsage } from "~/services/platform.v3.server";

export async function action({ request }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  try {
    return await reportComputeUsage(request);
  } catch (e) {
    logger.error("Error reporting compute usage", { error: e });
    return new Response(null, { status: 500 });
  }
}
