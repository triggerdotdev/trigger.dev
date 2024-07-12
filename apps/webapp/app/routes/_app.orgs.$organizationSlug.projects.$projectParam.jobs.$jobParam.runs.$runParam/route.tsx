import { useRevalidator } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { RunOverview } from "~/components/run/RunOverview";
import { useEventSource } from "~/hooks/useEventSource";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunPresenter } from "~/presenters/RunPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  RunParamsSchema,
  jobPath,
  jobRunsParentPath,
  runPath,
  runStreamingPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { runParam } = RunParamsSchema.parse(params);

  const presenter = new RunPresenter();
  const run = await presenter.call({
    userId,
    id: runParam,
  });

  if (!run) {
    throw new Response(null, {
      status: 404,
    });
  }

  return typedjson({
    run,
  });
};

export default function Page() {
  const { run } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();
  const user = useUser();

  const revalidator = useRevalidator();
  const events = useEventSource(runStreamingPath(organization, project, job, run), {
    event: "message",
    disabled: !!run.completedAt,
  });
  useEffect(() => {
    if (events !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <RunOverview
      run={run}
      trigger={job.event}
      showRerun={true}
      paths={{
        back: jobPath(organization, project, job),
        run: runPath(organization, project, job, run),
        runsPath: jobRunsParentPath(organization, project, job),
      }}
      currentUser={user}
    />
  );
}
