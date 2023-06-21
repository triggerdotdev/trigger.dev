import { client } from "@/trigger";
import "@/jobs/github";
import { createPagesRoute } from "@trigger.dev/nextjs";

const { handler, config } = createPagesRoute(client, { path: "/api/trigger" });

export { config };

export default handler;
