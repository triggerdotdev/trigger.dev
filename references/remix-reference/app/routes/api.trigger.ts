import { createRemixRoute } from "@trigger.dev/remix";

import { client } from "~/trigger";

// Remix will automatically strip files with side effects
// So you need to *export* your Job definitions like this:
export * from "~/jobs/example.server";

export const { action } = createRemixRoute(client);
