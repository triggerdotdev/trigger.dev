import { DetailedEvent } from "~/presenters/TriggerDetailsPresenter.server";
import { CodeBlock } from "../code/CodeBlock";
import { DateTime } from "../primitives/DateTime";
import { Header3 } from "../primitives/Headers";
import {
  RunPanel,
  RunPanelBody,
  RunPanelDivider,
  RunPanelHeader,
  RunPanelIconProperty,
  RunPanelIconSection,
  RunPanelProperties,
} from "./RunCard";
import { DisplayProperty } from "@trigger.dev/core";

export function TriggerDetail({
  trigger,
  event,
  properties,
}: {
  trigger: DetailedEvent;
  event: {
    title: string;
    icon: string;
  };
  properties: DisplayProperty[];
}) {
  const { id, name, payload, timestamp, deliveredAt } = trigger;

  return (
    <RunPanel selected={false}>
      <RunPanelHeader icon={event.icon} title={event.title} />
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
          {properties.length > 0 && (
            <div className="mb-2 flex flex-col gap-4">
              <Header3>Properties</Header3>
              <RunPanelProperties properties={properties} layout="horizontal" />
            </div>
          )}
          <Header3>Payload</Header3>
          <CodeBlock code={JSON.stringify(payload, null, 2)} />
        </div>
      </RunPanelBody>
    </RunPanel>
  );
}
