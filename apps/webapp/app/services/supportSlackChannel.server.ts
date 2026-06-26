import { WebClient } from "@slack/web-api";

export interface SupportSlackClient {
  createPrivateChannel(name: string): Promise<{ channelId: string; channelName: string }>;
  inviteSharedByEmail(
    channelId: string,
    email: string
  ): Promise<{ inviteId: string; url?: string }>;
}

// Slack channel names: lowercase, only [a-z0-9-], <= 80 chars.
export function supportChannelName(orgSlug: string): string {
  const cleaned = orgSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `cus-${cleaned}`.slice(0, 80);
}

export class SupportSlackClientLive implements SupportSlackClient {
  private readonly client: WebClient;

  constructor(token: string) {
    this.client = new WebClient(token);
  }

  async createPrivateChannel(name: string) {
    const res = await this.client.conversations.create({ name, is_private: true });
    const channelId = res.channel?.id;
    const channelName = res.channel?.name;
    if (!channelId || !channelName) {
      throw new Error("conversations.create returned no channel id/name");
    }
    return { channelId, channelName };
  }

  async inviteSharedByEmail(channelId: string, email: string) {
    // external_limited: false → Slack returns a clickable join `url` we surface in-app.
    const res = await this.client.conversations.inviteShared({
      channel: channelId,
      emails: [email],
      external_limited: false,
    });
    if (!res.invite_id) {
      throw new Error("conversations.inviteShared returned no invite_id");
    }
    return { inviteId: res.invite_id, url: res.url };
  }
}

/**
 * Creates a SupportSlackClient from an optional bot token.
 * Pass `env.SLACK_BOT_TOKEN` from the call site (env.server is not imported
 * here to keep this module testable — env.server transitively pulls in
 * packages that are only built in production).
 */
export function createSupportSlackClient(token: string | undefined): SupportSlackClient | null {
  if (!token) return null;
  return new SupportSlackClientLive(token);
}
