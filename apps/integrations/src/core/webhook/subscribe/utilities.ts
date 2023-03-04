export function webhookUrl(id: string): string {
  return `${process.env.WEBHOOKS_ORIGIN}/api/v1/webhooks/${id}/receive`;
}
