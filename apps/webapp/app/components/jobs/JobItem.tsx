import { Job, JobRunStatus } from ".prisma/client";
import { Link } from "@remix-run/react";
import { NamedIcon } from "../primitives/NamedIcon";

type JobItemProps = {
  to: string;
  icon: string;
  title: string;
  version: string;
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

export function JobItem({ to, icon, disabled = false }: JobItemProps) {
  return (
    <Link
      to={to}
      className="group flex w-full flex-col bg-slate-900 p-4 text-white transition duration-200 hover:bg-slate-850"
    >
      <div className="aspect-square w-fit rounded border border-slate-800 bg-slate-900 p-1.5 transition group-hover:border-slate-750 group-hover:bg-slate-800">
        <NamedIcon name={icon} className="h-12 w-12" />
      </div>
    </Link>
  );
}

export function JobList({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-slate-800 overflow-hidden rounded-md border border-slate-850">
      {children}
    </div>
  );
}

// <JobItem icon={"stripe"} properties={[{ key: "Repo", value: "triggerdotdet/trigger.dev"}]} />
