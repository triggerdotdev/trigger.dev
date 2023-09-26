import { createAstroRoute } from "@trigger.dev/astro";
//you may need to update this path to point at your trigger.ts file
import { client } from "${routePathPrefix}trigger";

//import your jobs
import "${routePathPrefix}jobs";

export const prerender = false;
export const { POST } = createAstroRoute(client);
