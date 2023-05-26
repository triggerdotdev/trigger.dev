import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { RunsTable } from "~/components/runs/RunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { RunListPresenter } from "~/presenters/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";

//todo defer the run list query
//todo live show when there are new items in the list

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { jobParam } = params;
  invariant(jobParam, "jobParam not found");

  const presenter = new RunListPresenter();
  const list = await presenter.call({ userId, jobId: jobParam });

  //todo identify job
  // analytics.job.identify({ job });
  return typedjson({
    list,
  });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "runs",
  },
};

export default function Page() {
  const { list } = useTypedLoaderData<typeof loader>();

  return (
    <div>
      <RunsTable total={10} hasFilters={false} runs={list.runs} />
    </div>
  );
}
