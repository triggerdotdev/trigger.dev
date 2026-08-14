import type {
  CreateScheduleOptions as CoreCreateScheduleOptions,
  ListScheduleOptions,
  ScheduledTaskPayload,
  UpdateScheduleOptions as CoreUpdateScheduleOptions,
  ValidatedScheduleWindow,
} from "@trigger.dev/core/v3";

export type { ListScheduleOptions, ScheduledTaskPayload };

export type CreateScheduleOptions<Window extends string | undefined = string | undefined> = Omit<
  CoreCreateScheduleOptions,
  "window"
> & {
  window?: ValidatedScheduleWindow<Window>;
};

export type UpdateScheduleOptions<Window extends string | undefined = string | undefined> = Omit<
  CoreUpdateScheduleOptions,
  "window"
> & {
  window?: ValidatedScheduleWindow<Window>;
};
