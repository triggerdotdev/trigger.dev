import { json } from "@remix-run/server-runtime";
import { createLoaderWorkerApiRoute } from "~/services/routeBuiilders/apiBuilder.server";

export const loader = createLoaderWorkerApiRoute({}, async ({ authenticatedWorker }) => {
  await authenticatedWorker.heartbeatWorkerInstance();
  return json({ ok: true });
});
