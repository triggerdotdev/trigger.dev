import { JobRunStatus } from ".prisma/client";
import { Link } from "@remix-run/react";
import { cn } from "~/utils/cn";
import { DateTime } from "../primitives/DateTime";
import { Header1 } from "../primitives/Headers";
import { IconNames, NamedIcon } from "../primitives/NamedIcon";
import { Paragraph } from "../primitives/Paragraph";
import { SimpleTooltip } from "../primitives/Tooltip";
import { runStatusTitle } from "../runs/RunStatuses";

type JobItemProps = {
  to: string;
  icon: string;
  title: string;
  version?: string;
  trigger: string;
  id: string;
  lastRun?: {
    status: JobRunStatus;
    createdAt: Date;
  };
  elements: {
    label: string;
    text: string;
    url?: string | undefined;
  }[];
  integrations: {
    title: string;
    icon: string;
  }[];
  disabled?: boolean;
};

export function JobItem({
  to,
  icon,
  title,
  version,
  trigger,
  id,
  lastRun,
  elements,
  integrations,
  disabled = false,
}: JobItemProps) {
  return (
    <Link
      to={to}
      className={cn(
        disabled ? "opacity-50 hover:bg-slate-900" : "hover:bg-slate-850",
        "group flex w-full gap-x-4 bg-slate-900 p-4 pr-5 text-white transition duration-200"
      )}
    >
      <div
        className={cn(
          disabled
            ? "border-slate-800 group-hover:border-slate-800 group-hover:bg-slate-900"
            : "border-slate-800 group-hover:border-slate-750 group-hover:bg-slate-850",
          "aspect-square h-fit w-fit rounded border p-1.5 transition"
        )}
      >
        <NamedIcon
          name={icon}
          className="h-6 w-6 md:h-10 md:w-10 lg:h-12 lg:w-12"
        />
      </div>
      <div className="flex w-full items-center">
        <div className="flex w-full flex-col gap-y-1">
          <div className="flex items-baseline justify-between gap-x-3 pr-3 md:justify-start md:pr-0">
            <Header1 className="font-medium">{title}</Header1>
            {version && (
              <JobVersion version={version} className="relative bottom-0.5" />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <KeyValue name="Trigger" value={trigger} />
            {integrations.length > 0 && (
              <KeyValue
                name="Integrations"
                // className="items-center"
                value={
                  <p className="flex gap-1 text-xs">
                    {integrations &&
                      integrations.map((integration, index) => (
                        <SimpleTooltip
                          key={index}
                          button={
                            <NamedIcon
                              key={integration.title}
                              name={integration.icon}
                              className="h-4 w-4"
                            />
                          }
                          content={integration.title}
                        />
                      ))}
                  </p>
                }
              />
            )}

            {elements.map((property) => (
              <KeyValue
                key={property.label}
                name={property.label}
                value={property.text}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <KeyValue name="Id" value={id} />
            <KeyValue
              name="Last Run"
              value={
                lastRun ? (
                  <Paragraph
                    variant="extra-small"
                    className={
                      lastRun.status === "FAILURE" ||
                      lastRun.status === "TIMED_OUT"
                        ? "text-rose-500"
                        : ""
                    }
                  >
                    {runStatusTitle(lastRun.status)}{" "}
                    <DateTime date={lastRun.createdAt} />
                  </Paragraph>
                ) : (
                  "Never run"
                )
              }
            />
          </div>
        </div>
        <NamedIcon
          name="chevron-right"
          className="h-4 w-4 text-dimmed transition duration-200 group-hover:translate-x-1.5 group-hover:text-bright"
        />
      </div>
    </Link>
  );
}

function KeyValue({
  name,
  value,
  className,
}: {
  name: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-x-1", className)}>
      <Paragraph
        variant="extra-extra-small/bright/caps"
        className="mt-0.5 whitespace-nowrap"
      >
        {name}:
      </Paragraph>
      {typeof value === "string" ? (
        <Paragraph variant="extra-small">{value}</Paragraph>
      ) : (
        value
      )}
    </div>
  );
}

export function JobVersion({
  version,
  className,
}: {
  version: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        className,
        "h-fit rounded border border-slate-750 bg-slate-850 px-1 py-0.5 text-xxs text-slate-400 md:text-xs"
      )}
    >
      v{version}
    </span>
  );
}

export function JobList({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-slate-800 overflow-hidden rounded-md border border-slate-850">
      {children}
    </div>
  );
}
