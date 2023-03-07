import type { LoaderArgs } from "@remix-run/server-runtime";
import { eventStream } from "remix-utils";
import { z } from "zod";
import { requireUserId } from "~/services/session.server";
import { findProjectById } from "../models/repositoryProject.server";

export async function loader({ request, params }: LoaderArgs) {
  await requireUserId(request);

  const { id } = z.object({ id: z.string() }).parse(params);

  const project = await findProjectById(id);

  if (!project) {
    return new Response("Not found", { status: 404 });
  }

  return eventStream(request.signal, (send) => {
    const interval = setInterval(() => {
      // Get the updatedAt date from the projects database, and send it to the client if it's different from the last one
      send({ event: "update", data: new Date().toISOString() });
    }, 5000);

    return function clear() {
      clearInterval(interval);
    };
  });
}
