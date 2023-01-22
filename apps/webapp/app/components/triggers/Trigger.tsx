import type {
  CustomEventTrigger,
  ScheduledEventTrigger,
  ScheduleSourceCron,
  ScheduleSourceRate,
  TriggerMetadata,
  WebhookEventTrigger,
} from "@trigger.dev/common-schemas";
import { Body } from "../primitives/text/Body";
import { Header2 } from "../primitives/text/Headers";
import cronstrue from "cronstrue";

export function TriggerBody({ trigger }: { trigger: TriggerMetadata }) {
  switch (trigger.type) {
    case "WEBHOOK":
      return <Webhook webhook={trigger} />;
    case "SCHEDULE":
      return <Scheduled event={trigger} />;
    case "CUSTOM_EVENT":
      return <CustomEvent event={trigger} />;
    case "HTTP_ENDPOINT":
      break;
    default:
      break;
  }
  return <></>;
}

const workflowNodeUppercaseClasses = "uppercase text-slate-400 tracking-wide";

function Webhook({ webhook }: { webhook: WebhookEventTrigger }) {
  return (
    <>
      <Header2 size="small" className="text-slate-300 mb-2">
        {webhook.name}
      </Header2>
      <div className="flex flex-col gap-1">
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
      <Body size="extra-small" className={workflowNodeUppercaseClasses}>
        Name
      </Body>
      <Header2 size="small" className="text-slate-300 mb-2">
        {event.name}
      </Header2>
    </>
  );
}

function Scheduled({ event }: { event: ScheduledEventTrigger }) {
  return (
    <>
      <div className={workflowNodeUppercaseClasses}>
        {"rateOf" in event.source ? (
          <RateOfScheduled source={event.source} />
        ) : (
          <AtScheduled source={event.source} />
        )}
      </div>
    </>
  );
}

function RateOfScheduled({ source }: { source: ScheduleSourceRate }) {
  const unit =
    "minutes" in source.rateOf
      ? source.rateOf.minutes > 1
        ? "minutes"
        : "minute"
      : "hours" in source.rateOf
      ? source.rateOf.hours > 1
        ? "hours"
        : "hour"
      : source.rateOf.days > 1
      ? "days"
      : "day";

  const value =
    "minutes" in source.rateOf
      ? source.rateOf.minutes
      : "hours" in source.rateOf
      ? source.rateOf.hours
      : source.rateOf.days;

  return (
    <div className="flex gap-2 items-baseline">
      <Body size="extra-small" className={workflowNodeUppercaseClasses}>
        Runs
      </Body>
      <Body size="small" className="text-slate-300 normal-case tracking-normal">
        Every {value} {unit}
      </Body>
    </div>
  );
}

function AtScheduled({ source }: { source: ScheduleSourceCron }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <Body size="extra-small" className={workflowNodeUppercaseClasses}>
          Runs
        </Body>
        <Body
          size="small"
          className="text-slate-300 normal-case tracking-normal"
        >
          {cronstrue.toString(source.cron, {
            throwExceptionOnParseError: false,
            verbose: false,
            use24HourTimeFormat: true,
          })}
        </Body>
      </div>
      <div className="flex items-baseline gap-2">
        <Body size="extra-small" className={workflowNodeUppercaseClasses}>
          Cron expression
        </Body>
        <Body
          size="small"
          className="text-slate-300 normal-case tracking-normal"
        >
          {source.cron}
        </Body>
      </div>
    </div>
  );
}
