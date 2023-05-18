import { JobRunStatus } from ".prisma/client";
import { Link } from "@remix-run/react";
import { NamedIcon } from "../primitives/NamedIcon";
import { Header1 } from "../primitives/Headers";
import { cn } from "~/utils/cn";
import { Paragraph } from "../primitives/Paragraph";

type JobItemProps = {
  to: string;
  icon: string;
  title: string;
  version?: string;
  trigger: string;
  id: string;
  lastRun?: {
    status: JobRunStatus;
    date: Date;
  };
  properties: {
    key: string;
    value: string;
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
  properties,
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
          "aspect-square w-fit rounded border p-1.5 transition"
        )}
      >
        <NamedIcon name={icon} className="h-12 w-12" />
      </div>
      <div className="flex w-full items-center">
        <div className="flex w-full flex-col">
          <div className="flex items-center gap-x-2">
            <Header1 className="font-medium">{title}</Header1>
            {version && <JobVersion version={version} />}
          </div>
          <div className="flex gap-x-4">
            <KeyValue name="Trigger" value={trigger} />
            {properties.map((property) => (
              <KeyValue
                key={property.key}
                name={property.key}
                value={property.value}
              />
            ))}
          </div>
          <div className="flex gap-x-4">
            <KeyValue name="Id" value={id} />
          </div>
        </div>
        <NamedIcon
          name="chevronRight"
          className="h-4 w-4 text-dimmed transition duration-200 group-hover:translate-x-1.5 group-hover:text-bright"
        />
      </div>
    </Link>
  );
}

function KeyValue({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex gap-1 align-baseline">
      <Paragraph variant="extra-extra-small/bright/caps">{name}:</Paragraph>
      <Paragraph variant="extra-small">{value}</Paragraph>
    </div>
  );
}

export function JobVersion({ version }: { version: string }) {
  return (
    <span className="rounded border border-slate-750 bg-slate-850 px-1 py-0.5 text-xs text-slate-400">
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
