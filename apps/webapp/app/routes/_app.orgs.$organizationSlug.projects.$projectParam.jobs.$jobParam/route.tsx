import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { getJob } from "~/models/job.server";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { jobParam } = params;
  invariant(jobParam, "jobParam not found");

  const job = await getJob({
    userId,
    id: jobParam,
  });

  if (job === null) {
    throw new Response("Not Found", { status: 404 });
  }

  //todo identify job
  // analytics.job.identify({ job });

  return typedjson({
    job,
  });
};

export default function Job() {
  return <Outlet />;
}
