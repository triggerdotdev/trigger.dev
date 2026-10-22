export function isAlertsConfigured(params: { alertsEnabled: string | undefined }): boolean {
  return params.alertsEnabled === "true" || params.alertsEnabled === "1";
}
