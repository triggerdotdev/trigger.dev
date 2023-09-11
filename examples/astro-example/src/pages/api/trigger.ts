import { createAstroRoute } from "@trigger.dev/astro";
import { client } from "../../../trigger";
import "../../../jobs/example";

export const { POST } = createAstroRoute(client);
