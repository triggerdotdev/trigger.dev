import { WebClient } from "@slack/web-api";
import { z } from "zod";
import { type PrismaClientOrTransaction } from "~/db.server";
import { logger } from "./logger.server";

export const OrganizationSupportChannelSchema = z.object({
  organizationId: z.string(),
});
export type OrganizationSupportChannelPayload = z.infer<
  typeof OrganizationSupportChannelSchema
>;

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

async function getOrganizationOwnerEmail(
  prisma: PrismaClientOrTransaction,
  organizationId: string
): Promise<string | null> {
  // First ADMIN member is treated as the org owner.
  const adminMember = await prisma.orgMember.findFirst({
    where: { organizationId, role: "ADMIN" },
    include: { user: { select: { email: true } } },
  });
  return adminMember?.user.email ?? null;
}

async function setStatus(
  prisma: PrismaClientOrTransaction,
  organizationId: string,
  status: "PENDING" | "PROVISIONING" | "INVITED" | "FAILED",
  data: {
    slackChannelId?: string | null;
    slackChannelName?: string | null;
    inviteUrl?: string | null;
    invitedEmail?: string | null;
    lastError?: string | null;
  } = {}
) {
  await prisma.organizationSupportChannel.upsert({
    where: { organizationId },
    create: { organizationId, status, ...data },
    update: { status, ...data },
  });
}

export async function provisionOrganizationSupportChannel({
  organizationId,
  prisma,
  slackClient,
}: {
  organizationId: string;
  prisma: PrismaClientOrTransaction;
  slackClient: SupportSlackClient;
}): Promise<{ status: "invited" | "exists" | "failed"; channelId?: string }> {
  const existing = await prisma.organizationSupportChannel.findFirst({
    where: { organizationId },
  });
  if (existing?.slackChannelId) {
    return { status: "exists", channelId: existing.slackChannelId };
  }

  const ownerEmail = await getOrganizationOwnerEmail(prisma, organizationId);
  if (!ownerEmail) {
    await setStatus(prisma, organizationId, "FAILED", {
      lastError: "No organization owner email found",
    });
    return { status: "failed" };
  }

  const org = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { slug: true },
  });
  if (!org) {
    await setStatus(prisma, organizationId, "FAILED", { lastError: "Organization not found" });
    return { status: "failed" };
  }

  await setStatus(prisma, organizationId, "PROVISIONING", { invitedEmail: ownerEmail });

  try {
    const { channelId, channelName } = await slackClient.createPrivateChannel(
      supportChannelName(org.slug)
    );
    const { url } = await slackClient.inviteSharedByEmail(channelId, ownerEmail);
    await prisma.organizationSupportChannel.update({
      where: { organizationId },
      data: {
        status: "INVITED",
        slackChannelId: channelId,
        slackChannelName: channelName,
        inviteUrl: url ?? null,
        lastError: null,
      },
    });
    return { status: "invited", channelId };
  } catch (error) {
    await setStatus(prisma, organizationId, "FAILED", {
      lastError: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed" };
  }
}

export async function enqueueProvisionSupportChannel(
  payload: OrganizationSupportChannelPayload
) {
  try {
    // Lazy import to avoid a circular dependency with commonWorker (which imports this module's schema).
    const { commonWorker } = await import("~/v3/commonWorker.server");
    await commonWorker.enqueue({
      id: `support-channel:${payload.organizationId}`,
      job: "supportChannel.provision",
      payload,
    });
  } catch (error) {
    logger.error("Failed to enqueue support channel provisioning", {
      organizationId: payload.organizationId,
      error,
    });
  }
}
