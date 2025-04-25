import { EnvelopeIcon } from "@heroicons/react/20/solid";
import {
  exceptionEventEnhancer,
  isExceptionSpanEvent,
  type ExceptionEventProperties,
  type SpanEvent as OtelSpanEvent,
} from "@trigger.dev/core/v3";
import { CodeBlock } from "~/components/code/CodeBlock";
import { Feedback } from "~/components/Feedback";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";

type SpanEventsProps = {
  spanEvents: OtelSpanEvent[];
};

export function SpanEvents({ spanEvents }: SpanEventsProps) {
  const displayableEvents = spanEvents.filter((event) => !event.name.startsWith("trigger.dev/"));

  if (displayableEvents.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4">
      {displayableEvents.map((event, index) => (
        <SpanEvent key={index} spanEvent={event} />
      ))}
    </div>
  );
}

function SpanEventHeader({
  title,
  titleClassName,
  time,
}: {
  title: string;
  titleClassName?: string;
  time: Date;
}) {
  return (
    <div className="flex items-center justify-between">
      <Header3 className={titleClassName}>{title}</Header3>
      <Paragraph variant="extra-small">
        <DateTimeAccurate date={time} />
      </Paragraph>
    </div>
  );
}

function SpanEvent({ spanEvent }: { spanEvent: OtelSpanEvent }) {
  if (isExceptionSpanEvent(spanEvent)) {
    return <SpanEventError spanEvent={spanEvent} exception={spanEvent.properties.exception} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <SpanEventHeader title={spanEvent.name} time={spanEvent.time} />
      {spanEvent.properties && (
        <CodeBlock code={JSON.stringify(spanEvent.properties, null, 2)} maxLines={20} />
      )}
    </div>
  );
}

export function SpanEventError({
  spanEvent,
  exception,
}: {
  spanEvent: OtelSpanEvent;
  exception: ExceptionEventProperties;
}) {
  const enhancedException = exceptionEventEnhancer(exception);

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-rose-500/50 px-3 pb-3 pt-2">
      <SpanEventHeader
        title={enhancedException.type ?? "Error"}
        time={spanEvent.time}
        titleClassName="text-rose-500"
      />
      {enhancedException.message && (
        <Callout variant="error">
          <pre className="text-wrap font-sans text-sm font-normal text-rose-200">
            {enhancedException.message}
          </pre>
        </Callout>
      )}
      {enhancedException.link &&
        (enhancedException.link.magic === "CONTACT_FORM" ? (
          <Feedback
            button={
              <Button
                variant="tertiary/medium"
                LeadingIcon={EnvelopeIcon}
                leadingIconClassName="text-blue-400"
                fullWidth
                textAlignLeft
              >
                {enhancedException.link.name}
              </Button>
            }
          />
        ) : (
          <Callout variant="docs" to={enhancedException.link.href}>
            {enhancedException.link.name}
          </Callout>
        ))}
      {enhancedException.stacktrace && (
        <CodeBlock
          showCopyButton={false}
          showLineNumbers={false}
          code={enhancedException.stacktrace}
          maxLines={20}
        />
      )}
    </div>
  );
}
