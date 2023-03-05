export function webhookUrl(id: string): string {
  return `${process.env.WEBHOOKS_ORIGIN}/api/v2/webhooks/${id}/receive`;
}
