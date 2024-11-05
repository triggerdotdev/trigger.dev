import { json } from "@remix-run/server-runtime";
import { createLoaderWorkerApiRoute } from "~/services/routeBuiilders/apiBuilder.server";

export const loader = createLoaderWorkerApiRoute({}, async ({ authenticatedWorker }) => {
  return json(await authenticatedWorker.dequeue());
});
