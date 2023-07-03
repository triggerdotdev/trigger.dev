import { client } from "@/trigger";
import "@/jobs/github";
import "@/jobs/openai";
import "@/jobs/resend";
import "@/jobs/general";
import "@/jobs/slack";
import "@/jobs/logging";
import { createPagesRoute } from "@trigger.dev/nextjs";

const { handler, config } = createPagesRoute(client);

export { config };

export default handler;
