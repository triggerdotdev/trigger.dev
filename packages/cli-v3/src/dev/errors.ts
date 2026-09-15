export const SCHEDULE_PLAN_LIMIT_HEADER = "Free plan limited to hourly schedules or less";

export class SchedulePlanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulePlanLimitError";
  }
}
