export function webhookUrl(id: string): string {
  return `${process.env.INTEGRATIONS_ORIGIN}/api/v1/webhooks/${id}/receive`;
}
