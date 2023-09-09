import { createRemixRoute } from "@trigger.dev/remix";

import { client } from "~/trigger";

//TODO: look for a better way to run side effects
//import your jobs
import { configureJob } from "~/jobs/example";

configureJob();

export const { action } = createRemixRoute(client);
