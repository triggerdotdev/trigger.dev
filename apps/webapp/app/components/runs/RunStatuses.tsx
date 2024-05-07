import { NoSymbolIcon } from "@heroicons/react/20/solid";
import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  PauseCircleIcon,
  WrenchIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import type { JobRunStatus } from "@trigger.dev/database";
import { cn } from "~/utils/cn";
import { Spinner } from "../primitives/Spinner";
import { z } from "zod";
import assertNever from "assert-never";

export function RunStatus({ status }: { status: JobRunStatus }) {
  return (
    <span className="flex items-center gap-1">
      <RunStatusIcon status={status} className="h-4 w-4" />
      <RunStatusLabel status={status} />
    </span>
  );
}

export function RunStatusLabel({ status }: { status: JobRunStatus }) {
  return <span className={runStatusClassNameColor(status)}>{runStatusTitle(status)}</span>;
}

export function RunStatusIcon({ status, className }: { status: JobRunStatus; className: string }) {
  switch (status) {
    case "SUCCESS":
      return <CheckCircleIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "PENDING":
    case "WAITING_TO_CONTINUE":
      return <ClockIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "QUEUED":
    case "WAITING_TO_EXECUTE":
      return <PauseCircleIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "PREPROCESSING":
    case "STARTED":
    case "EXECUTING":
      return <Spinner className={cn(runStatusClassNameColor(status), className)} />;
    case "TIMED_OUT":
      return <ExclamationTriangleIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "UNRESOLVED_AUTH":
    case "FAILURE":
    case "ABORTED":
    case "INVALID_PAYLOAD":
      return <XCircleIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "WAITING_ON_CONNECTIONS":
      return <WrenchIcon className={cn(runStatusClassNameColor(status), className)} />;
    case "CANCELED":
      return <NoSymbolIcon className={cn(runStatusClassNameColor(status), className)} />;
    default: {
      assertNever(status);
    }
  }
}

export function runStatusTitle(status: JobRunStatus): string {
  switch (status) {
    case "SUCCESS":
      return "Completed";
    case "PENDING":
      return "Not started";
    case "STARTED":
      return "In progress";
    case "QUEUED":
    case "WAITING_TO_EXECUTE":
      return "Queued";
    case "EXECUTING":
      return "Executing";
    case "WAITING_TO_CONTINUE":
      return "Waiting";
    case "FAILURE":
      return "Failed";
    case "TIMED_OUT":
      return "Timed out";
    case "WAITING_ON_CONNECTIONS":
      return "Waiting on connections";
    case "ABORTED":
      return "Aborted";
    case "PREPROCESSING":
      return "Preprocessing";
    case "CANCELED":
      return "Canceled";
    case "UNRESOLVED_AUTH":
      return "Unresolved auth";
    case "INVALID_PAYLOAD":
      return "Invalid payload";
    default: {
      assertNever(status);
    }
  }
}

export function runStatusClassNameColor(status: JobRunStatus): string {
  switch (status) {
    case "SUCCESS":
      return "text-green-500";
    case "PENDING":
      return "text-charcoal-500";
    case "STARTED":
    case "EXECUTING":
    case "WAITING_TO_CONTINUE":
    case "WAITING_TO_EXECUTE":
      return "text-blue-500";
    case "QUEUED":
      return "text-charcoal-500";
    case "FAILURE":
    case "UNRESOLVED_AUTH":
    case "INVALID_PAYLOAD":
      return "text-rose-500";
    case "TIMED_OUT":
      return "text-amber-300";
    case "WAITING_ON_CONNECTIONS":
      return "text-amber-300";
    case "ABORTED":
      return "text-rose-500";
    case "PREPROCESSING":
      return "text-blue-500";
    case "CANCELED":
      return "text-charcoal-500";
    default: {
      assertNever(status);
    }
  }
}

export const DirectionSchema = z.union([z.literal("forward"), z.literal("backward")]);
export type Direction = z.infer<typeof DirectionSchema>;

export const FilterableStatus = z.union([
  z.literal("QUEUED"),
  z.literal("IN_PROGRESS"),
  z.literal("WAITING"),
  z.literal("COMPLETED"),
  z.literal("FAILED"),
  z.literal("TIMEDOUT"),
  z.literal("CANCELED"),
]);
export type FilterableStatus = z.infer<typeof FilterableStatus>;

export const FilterableEnvironment = z.union([
  z.literal("DEVELOPMENT"),
  z.literal("STAGING"),
  z.literal("PRODUCTION"),
]);
export type FilterableEnvironment = z.infer<typeof FilterableEnvironment>;
export const environmentKeys: FilterableEnvironment[] = ["DEVELOPMENT", "STAGING", "PRODUCTION"];

export const RunListSearchSchema = z.object({
  cursor: z.string().optional(),
  direction: DirectionSchema.optional(),
  status: FilterableStatus.optional(),
  environment: FilterableEnvironment.optional(),
  from: z
    .string()
    .transform((value) => parseInt(value))
    .optional(),
  to: z
    .string()
    .transform((value) => parseInt(value))
    .optional(),
});

export const filterableStatuses: Record<FilterableStatus, JobRunStatus[]> = {
  QUEUED: ["QUEUED", "WAITING_TO_EXECUTE", "PENDING", "WAITING_ON_CONNECTIONS"],
  IN_PROGRESS: ["STARTED", "EXECUTING", "PREPROCESSING"],
  WAITING: ["WAITING_TO_CONTINUE"],
  COMPLETED: ["SUCCESS"],
  FAILED: ["FAILURE", "UNRESOLVED_AUTH", "INVALID_PAYLOAD", "ABORTED"],
  TIMEDOUT: ["TIMED_OUT"],
  CANCELED: ["CANCELED"],
};

export const statusKeys: FilterableStatus[] = Object.keys(filterableStatuses) as FilterableStatus[];
