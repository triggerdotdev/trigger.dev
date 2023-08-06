import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { TriggerDetail } from "~/components/run/TriggerDetail";
import { useJob } from "~/hooks/useJob";
import { useRun } from "~/hooks/useRun";
import { TriggerDetailsPresenter } from "~/presenters/TriggerDetailsPresenter.server";
import { RunParamsSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const { runParam } = RunParamsSchema.parse(params);

  const presenter = new TriggerDetailsPresenter();
  const trigger = await presenter.call(runParam);

  if (!trigger) {
    throw new Response(null, {
      status: 404,
    });
  }

  return typedjson({
    trigger,
  });
};

export default function Page() {
  const { trigger } = useTypedLoaderData<typeof loader>();
  const job = useJob();
  const run = useRun();

  return <TriggerDetail trigger={trigger} event={job.event} properties={run.properties} />;
}
