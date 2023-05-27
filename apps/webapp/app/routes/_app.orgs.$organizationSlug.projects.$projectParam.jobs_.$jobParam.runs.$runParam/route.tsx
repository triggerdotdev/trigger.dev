import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { RunPresenter } from "~/presenters/RunPresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { jobParam, runParam } = params;
  invariant(jobParam, "jobParam not found");
  invariant(runParam, "runParam not found");

  const presenter = new RunPresenter();
  const run = await presenter.call({
    userId,
    id: runParam,
  });

  return typedjson({
    run,
  });
};

//todo breadcrumb
export const handle: Handle = {
  // breadcrumb: {
  // slug: "run",
  // },
};

export default function Page() {
  const { run } = useTypedLoaderData<typeof loader>();

  return <div>Run #{run?.number} page</div>;
}
