import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { CodeBlock } from "~/components/code/CodeBlock";
import { Header3 } from "~/components/primitives/Headers";
import { requireUserId } from "~/services/session.server";
import { formatDateTime } from "~/utils";
import {
  RunPanel,
  RunPanelBody,
  RunPanelElements,
  RunPanelHeader,
  RunPanelIconElement,
  RunPanelIconSection,
} from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam.runs.$runParam/RunCard";
import { EventDetailsPresenter } from "~/presenters/EventDetailsPresenter.server";
import { useJob } from "~/hooks/useJob";
import { useRun } from "~/hooks/useRun";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { jobParam, runParam, eventParam } = params;
  invariant(jobParam, "jobParam not found");
  invariant(runParam, "runParam not found");
  invariant(eventParam, "eventParam not found");

  const presenter = new EventDetailsPresenter();
  const event = await presenter.call({
    userId,
    id: eventParam,
  });

  if (!event) {
    throw new Response(null, {
      status: 404,
    });
  }

  return typedjson({
    event,
  });
};

export default function Page() {
  const { event } = useTypedLoaderData<typeof loader>();
  const job = useJob();
  const run = useRun();

  const { id, name, payload, timestamp, deliveredAt } = event;

  return (
    <RunPanel selected={false}>
      <RunPanelHeader icon={job.event.icon} title={job.event.title} />
      <RunPanelBody>
        <div className="mb-4 border-b border-slate-800 pb-4">
          <RunPanelIconSection>
            <RunPanelIconElement
              icon="calendar"
              label="Created"
              value={formatDateTime(timestamp, "long")}
            />
            {deliveredAt && (
              <RunPanelIconElement
                icon="flag"
                label="Finished at"
                value={formatDateTime(deliveredAt, "long")}
              />
            )}
            <RunPanelIconElement icon="id" label="Event name" value={name} />
          </RunPanelIconSection>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {run.elements.length > 0 && (
            <div className="mb-2 flex flex-col gap-4">
              <Header3>Properties</Header3>
              <RunPanelElements elements={run.elements} layout="vertical" />
            </div>
          )}
          <Header3>Payload</Header3>
          <CodeBlock code={JSON.stringify(payload, null, 2)} />
        </div>
      </RunPanelBody>
    </RunPanel>
  );
}
