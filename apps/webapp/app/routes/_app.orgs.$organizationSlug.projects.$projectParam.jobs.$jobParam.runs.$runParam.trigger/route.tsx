import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { TriggerDetail } from "~/components/run/TriggerDetail";
import { useJob } from "~/hooks/useJob";
import { useRun } from "~/hooks/useRun";
import { TriggerDetailsPresenter } from "~/presenters/TriggerDetailsPresenter.server";
import { RunParamsSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
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

  // For compatibility with old Job Runs where payload is only available on the related Event Record
  const payload =
    run.payload !== null ? JSON.stringify(JSON.parse(run.payload), null, 2) : trigger.payload;

  return (
    <TriggerDetail
      trigger={trigger}
      batched={run.batched}
      event={job.event}
      eventIds={run.eventIds}
      payload={payload}
      properties={run.properties}
    />
  );
}
