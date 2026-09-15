export function runTriggeredAt({
  createdAt,
  queueTimestamp,
  scheduleId,
}: {
  createdAt: Date;
  queueTimestamp?: Date | null;
  scheduleId?: string | null;
}) {
  return scheduleId && queueTimestamp ? queueTimestamp : createdAt;
}
