/**
 * Strip a client-forged `actionSource: "webhook"` from a session `.in` append part.
 *
 * Only the hosted webhook ingress may claim webhook trust, and it appends server-side rather than
 * through the client append route. A client with session write access could otherwise send a record
 * carrying `actionSource: "webhook"`, which the run loop uses to skip action-schema validation. We
 * downgrade it here (delete the field) so the record is validated as a normal client action.
 */
export function stripClientWebhookActionSource(part: string): string {
  if (!part.includes('"actionSource"')) return part;

  let record: { payload?: { actionSource?: string } } | undefined;
  try {
    record = JSON.parse(part) as { payload?: { actionSource?: string } };
  } catch {
    return part;
  }

  if (record?.payload?.actionSource === "webhook") {
    delete record.payload.actionSource;
    return JSON.stringify(record);
  }

  return part;
}
