export function isV2AlertId(id: string): boolean {
  return id.startsWith("alert_");
}

export function isNewAlertAction(action: string, id: string): boolean {
  return (
    action === "resolve" ||
    action === "stop" ||
    action === "ungroup" ||
    action === "rename" ||
    (action === "delete" && isV2AlertId(id))
  );
}
