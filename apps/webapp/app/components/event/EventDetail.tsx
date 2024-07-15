import { CodeBlock } from "../code/CodeBlock";
import { DateTime } from "../primitives/DateTime";
import { Header3 } from "../primitives/Headers";
import {
  RunPanel,
  RunPanelBody,
  RunPanelDivider,
  RunPanelIconProperty,
  RunPanelIconSection,
} from "~/components/run/RunCard";
import { type Event } from "~/presenters/EventPresenter.server";

export function EventDetail({ event }: { event: Event }) {
  const { id, name, payload, context, timestamp, deliveredAt } = event;

  return (
    <RunPanel selected={false}>
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
              label="Delivered"
              value={<DateTime date={deliveredAt} />}
            />
          )}
          <RunPanelIconProperty icon="id" label="Event name" value={name} />
          <RunPanelIconProperty icon="account" label="Event ID" value={id} />
        </RunPanelIconSection>
        <RunPanelDivider />
        <div className="mt-4 flex flex-col gap-2">
          <Header3>Payload</Header3>
          <CodeBlock code={payload} />
          <Header3>Context</Header3>
          <CodeBlock code={context} />
        </div>
      </RunPanelBody>
    </RunPanel>
  );
}
