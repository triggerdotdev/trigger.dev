import type { TaskRunStatus } from "@trigger.dev/database";

/** A run as the session runs route returns it. Run fields are null until the run is in the run store. */
export type SessionTraceRun = {
  number: number;
  friendlyId: string;
  reason: string;
  afterCrash: boolean;
  status: TaskRunStatus | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

/** The parts of a trace tree event the session tree needs. */
export type SessionTraceSpan<TData> = {
  id: string;
  parentId?: string;
  level: number;
  data: TData;
};
