import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { CodeBlock } from "~/components/code/CodeBlock";
import { DateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { useJob } from "~/hooks/useJob";
import { useRun } from "~/hooks/useRun";
import { EventDetailsPresenter } from "~/presenters/EventDetailsPresenter.server";
import { RunParamsSchema } from "~/utils/pathBuilder";
import {
  RunPanel,
  RunPanelBody,
  RunPanelDivider,
  RunPanelHeader,
  RunPanelIconProperty,
  RunPanelIconSection,
  RunPanelProperties,
} from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam.runs.$runParam/RunCard";

export const loader = async ({ request, params }: LoaderArgs) => {
  const { runParam } = RunParamsSchema.parse(params);

  const presenter = new EventDetailsPresenter();
  const event = await presenter.call(runParam);

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
        <RunPanelIconSection>
          <RunPanelIconProperty
            icon="calendar"
            label="Created"
            value={<DateTime date={timestamp} />}
          />
          {deliveredAt && (
            <RunPanelIconProperty
              icon="flag"
              label="Finished at"
              value={<DateTime date={deliveredAt} />}
            />
          )}
          <RunPanelIconProperty icon="id" label="Event name" value={name} />
        </RunPanelIconSection>
        <RunPanelDivider />
        <div className="mt-4 flex flex-col gap-2">
          {run.properties.length > 0 && (
            <div className="mb-2 flex flex-col gap-4">
              <Header3>Properties</Header3>
              <RunPanelProperties
                properties={run.properties}
                layout="horizontal"
              />
            </div>
          )}
          <Header3>Payload</Header3>
          <CodeBlock code={JSON.stringify(payload, null, 2)} />
        </div>
      </RunPanelBody>
    </RunPanel>
  );
}
