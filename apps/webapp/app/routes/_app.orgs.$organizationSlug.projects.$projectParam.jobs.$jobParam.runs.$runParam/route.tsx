import { useRevalidator } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { Fragment, useEffect } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { BreadcrumbIcon } from "~/components/primitives/BreadcrumbIcon";
import { RunOverview } from "~/components/run/RunOverview";
import { jobMatchId, useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useTypedMatchData } from "~/hooks/useTypedMatchData";
import { RunPresenter } from "~/presenters/RunPresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import {
  RunParamsSchema,
  jobPath,
  jobRunsParentPath,
  runPath,
  runStreamingPath,
  trimTrailingSlash,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
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

export const handle: Handle = {
  breadcrumb: (match, matches) => {
    const jobMatch = matches.find((m) => m.id === jobMatchId);
    const runData = useTypedMatchData<typeof loader>(match);

    return (
      <Fragment>
        <BreadcrumbLink
          to={trimTrailingSlash(jobMatch?.pathname ?? "")}
          title="Runs"
        />
        <BreadcrumbIcon />
        {runData && runData.run && (
          <BreadcrumbLink
            to={match.pathname}
            title={`Run #${runData.run.number}`}
          />
        )}
      </Fragment>
    );
  },
};

export default function Page() {
  const { run } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();

  const revalidator = useRevalidator();
  const events = useEventSource(
    runStreamingPath(organization, project, job, run),
    {
      event: "message",
    }
  );
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
    />
  );
}
