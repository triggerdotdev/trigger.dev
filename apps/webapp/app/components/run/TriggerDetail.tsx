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
  payload,
  context,
  event,
  properties,
  batched = false,
  eventIds,
}: {
  trigger: DetailedEvent;
  payload: string;
  context: string;
  event: {
    title: string;
    icon: string;
  };
  properties: DisplayProperty[];
  batched?: boolean;
  eventIds?: string[];
}) {
  const { id, name, timestamp, deliveredAt } = trigger;

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
          {batched ? (
            <>
              <RunPanelIconProperty icon="packages" label="Batched" value={String(batched)} />
              <RunPanelIconProperty
                icon="hash"
                label="Total Events"
                value={eventIds ? eventIds.length : 0}
              />
            </>
          ) : (
            <RunPanelIconProperty icon="account" label="Event ID" value={id} />
          )}
          {trigger.externalAccount && (
            <RunPanelIconProperty
              icon="account"
              label="Account ID"
              value={trigger.externalAccount.identifier}
            />
          )}
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
          <CodeBlock code={payload} />
          <Header3>Context</Header3>
          <CodeBlock code={context} />
          {batched && eventIds && (
            <>
              <Header3>Event IDs</Header3>
              <CodeBlock code={JSON.stringify(eventIds, null, 2)} />
            </>
          )}
        </div>
      </RunPanelBody>
    </RunPanel>
  );
}
