import { createAppRoute } from "@trigger.dev/nextjs";
import { client } from "@/trigger";

import "@/jobs/hooks";

export const { POST, dynamic } = createAppRoute(client);
