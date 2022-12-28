import type {
  CustomEventTrigger,
  TriggerMetadata,
  WebhookEventTrigger,
} from "@trigger.dev/common-schemas";
import { Body } from "../primitives/text/Body";
import { Header2, Header3 } from "../primitives/text/Headers";

export function TriggerBody({ trigger }: { trigger: TriggerMetadata }) {
  switch (trigger.type) {
    case "WEBHOOK":
      return <Webhook webhook={trigger} />;
    case "SCHEDULE":
      break;
    case "CUSTOM_EVENT":
      return <CustomEvent event={trigger} />;
    case "HTTP_ENDPOINT":
      break;
    default:
      break;
  }
  return <></>;
}

const workflowNodeUppercaseClasses = "uppercase text-slate-400";

function Webhook({ webhook }: { webhook: WebhookEventTrigger }) {
  return (
    <>
      <Header3 size="large" className="mb-2">
        {webhook.name}
      </Header3>
      <div className="flex flex-col gap-1 mb-2">
        {webhook.source &&
          Object.entries(webhook.source).map(([key, value]) => (
            <div key={key} className="flex gap-2 items-baseline">
              <Body size="extra-small" className={workflowNodeUppercaseClasses}>
                {key}
              </Body>
              <Body size="small">{value}</Body>
            </div>
          ))}
      </div>
    </>
  );
}

function CustomEvent({ event }: { event: CustomEventTrigger }) {
  return (
    <>
      <Header2 size="large" className="mb-4">
        name: {event.name}
      </Header2>
    </>
  );
}
