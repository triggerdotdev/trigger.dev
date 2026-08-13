import { WebClient } from "@slack/web-api";
import { z } from "zod";
import { type PrismaClientOrTransaction } from "~/db.server";

export const OrganizationSupportChannelSchema = z.object({
  organizationId: z.string(),
});
export type OrganizationSupportChannelPayload = z.infer<typeof OrganizationSupportChannelSchema>;

export interface SupportSlackClient {
  createPrivateChannel(name: string): Promise<{ channelId: string; channelName: string }>;
  inviteSharedByEmail(
    channelId: string,
    email: string
  ): Promise<{ inviteId: string; url?: string }>;
  archiveChannel(channelId: string): Promise<void>;
  unarchiveChannel(channelId: string): Promise<void>;
}

// Slack surfaces "already in that state" as a platform error rather than success.
// Both archive and unarchive treat their respective already-there error as a no-op success.
function isSlackErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof (error as { data?: unknown }).data === "object" &&
    (error as { data?: { error?: unknown } }).data !== null &&
    (error as { data?: { error?: unknown } }).data?.error === code
  );
}

/**
 * `retryable` tells the worker whether to throw (and burn a retry attempt) or
 * accept the job. Slack errors are transient; a missing owner or org is not.
 */
export type ProvisionResult =
  | { status: "invited" | "exists"; channelId?: string }
  | { status: "failed"; retryable: boolean; channelId?: string };

export interface SupportSlackDiscoveryClient {
  ownTeamId(): Promise<string>;
  listCustomerChannels(): Promise<
    Array<{ channelId: string; channelName: string; connectedTeamIds: string[] }>
  >;
  getTeamDomains(teamId: string): Promise<{ domain?: string; emailDomain?: string }>;
}

// A channel is treated as a customer support channel only when it follows the
// `cus-` naming convention AND is actually a Slack Connect (externally shared) channel.
export function isCustomerSupportChannel({
  name,
  is_ext_shared,
}: {
  name?: string;
  is_ext_shared?: boolean;
}): boolean {
  return name?.startsWith("cus-") === true && is_ext_shared === true;
}

// Slack Connect channels list the connected workspaces' team ids, including our own.
// This picks the first id that isn't ours, i.e. the customer's workspace.
export function pickExternalTeamId(
  connectedTeamIds: string[] | undefined,
  ownTeamId: string
): string | undefined {
  return connectedTeamIds?.find((teamId) => teamId !== ownTeamId);
}

export function hasPrivateSlackSupport(
  plan:
    | {
        v3Subscription?: {
          plan?: { limits?: { supportChannel?: boolean; [key: string]: unknown } };
        };
      }
    | null
    | undefined
): boolean {
  return plan?.v3Subscription?.plan?.limits?.supportChannel === true;
}

export function isPaidPlan(
  plan: { v3Subscription?: { isPaying?: boolean } } | null | undefined
): boolean {
  return plan?.v3Subscription?.isPaying === true;
}

// An org is "downgraded" when it still has a support channel linked but is no
// longer on a paying plan, e.g. it downgraded after the channel was created.
export function isDowngradedLink({
  hasChannel,
  isPaying,
}: {
  hasChannel: boolean;
  isPaying: boolean;
}): boolean {
  return hasChannel && !isPaying;
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

export class SupportSlackClientLive implements SupportSlackClient, SupportSlackDiscoveryClient {
  private readonly client: WebClient;
  private cachedOwnTeamId: string | undefined;

  constructor(token: string) {
    this.client = new WebClient(token);
  }

  async ownTeamId(): Promise<string> {
    if (this.cachedOwnTeamId) {
      return this.cachedOwnTeamId;
    }
    const res = await this.client.auth.test();
    const teamId = res.team_id;
    if (!teamId) {
      throw new Error("auth.test returned no team_id");
    }
    this.cachedOwnTeamId = teamId;
    return teamId;
  }

  async listCustomerChannels(): Promise<
    Array<{ channelId: string; channelName: string; connectedTeamIds: string[] }>
  > {
    const channels: Array<{ channelId: string; channelName: string; connectedTeamIds: string[] }> =
      [];
    let cursor: string | undefined;

    do {
      const res = await this.client.users.conversations({
        types: "private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });

      for (const c of res.channels ?? []) {
        if (!isCustomerSupportChannel({ name: c.name, is_ext_shared: c.is_ext_shared })) {
          continue;
        }
        if (!c.id || !c.name) {
          continue;
        }
        channels.push({
          channelId: c.id,
          channelName: c.name,
          // users.conversations does not return connected_team_ids — only
          // conversations.info does. Fetched per channel below.
          connectedTeamIds: await this.connectedTeamIds(c.id),
        });
      }

      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return channels;
  }

  private async connectedTeamIds(channelId: string): Promise<string[]> {
    try {
      const res = await this.client.conversations.info({ channel: channelId });
      return (
        (res.channel as { connected_team_ids?: string[] } | undefined)?.connected_team_ids ?? []
      );
    } catch {
      // Best-effort: the team ids only feed the domain matching hint, so a
      // failure here degrades the proposal rather than breaking discovery.
      return [];
    }
  }

  async getTeamDomains(teamId: string): Promise<{ domain?: string; emailDomain?: string }> {
    try {
      const res = await this.client.team.info({ team: teamId });
      return { domain: res.team?.domain, emailDomain: res.team?.email_domain };
    } catch {
      // Best-effort enrichment only: cross-org team.info can fail, and the domain is
      // just a matching hint. Fall back to no domains rather than failing discovery.
      return {};
    }
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

  async archiveChannel(channelId: string): Promise<void> {
    try {
      await this.client.conversations.archive({ channel: channelId });
    } catch (error) {
      if (isSlackErrorCode(error, "already_archived")) {
        return;
      }
      throw error;
    }
  }

  async unarchiveChannel(channelId: string): Promise<void> {
    try {
      await this.client.conversations.unarchive({ channel: channelId });
    } catch (error) {
      if (isSlackErrorCode(error, "not_archived")) {
        return;
      }
      throw error;
    }
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

/**
 * Creates a SupportSlackDiscoveryClient from an optional bot token.
 * Pass `env.SLACK_BOT_TOKEN` from the call site (see createSupportSlackClient above).
 */
export function createSupportSlackDiscoveryClient(
  token: string | undefined
): SupportSlackDiscoveryClient | null {
  if (!token) return null;
  return new SupportSlackClientLive(token);
}

async function getOrganizationOwnerEmail(
  prisma: PrismaClientOrTransaction,
  organizationId: string
): Promise<string | null> {
  // Longest-standing ADMIN member is treated as the org owner. Ordering is
  // load-bearing: without it the invite recipient varies between runs, so a
  // retry can email a different person than the first attempt. Matches the
  // admin page's owner lookup.
  const adminMember = await prisma.orgMember.findFirst({
    where: { organizationId, role: "ADMIN" },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { email: true } } },
  });
  return adminMember?.user.email ?? null;
}

async function setStatus(
  prisma: PrismaClientOrTransaction,
  organizationId: string,
  status: "PENDING" | "PROVISIONING" | "INVITED" | "FAILED" | "ARCHIVED",
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
}): Promise<ProvisionResult> {
  const existing = await prisma.organizationSupportChannel.findFirst({
    where: { organizationId },
  });
  if (existing?.slackChannelId && (existing.status === "INVITED" || existing.status === "LINKED")) {
    return { status: "exists", channelId: existing.slackChannelId };
  }

  const ownerEmail = await getOrganizationOwnerEmail(prisma, organizationId);
  if (!ownerEmail) {
    await setStatus(prisma, organizationId, "FAILED", {
      lastError: "No organization owner email found",
    });
    // Permanent: no amount of retrying invents an owner.
    return { status: "failed", retryable: false };
  }

  // A re-upgrade after an unlink (archive) reuses the existing channel: recreating the
  // same `cus-<slug>` name would fail with Slack `name_taken`, so unarchive it instead.
  if (existing?.status === "ARCHIVED" && existing.slackChannelId) {
    const channelId = existing.slackChannelId;
    const channelName = existing.slackChannelName ?? undefined;
    await setStatus(prisma, organizationId, "PROVISIONING", {
      slackChannelId: channelId,
      slackChannelName: channelName,
      invitedEmail: ownerEmail,
    });

    try {
      await slackClient.unarchiveChannel(channelId);
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
      // Stay ARCHIVED rather than dropping to FAILED: the channel is still
      // archived in Slack, and only this branch unarchives it. Marking it FAILED
      // would send the next attempt down the reuse path, which invites into an
      // archived channel and fails forever.
      await setStatus(prisma, organizationId, "ARCHIVED", {
        slackChannelId: channelId,
        slackChannelName: channelName,
        lastError: error instanceof Error ? error.message : String(error),
      });
      return { status: "failed", retryable: true };
    }
  }

  // A previous attempt may have already created the Slack channel but died (or failed)
  // before recording the invite. Reuse the persisted channel instead of re-creating it,
  // since Slack rejects a second `conversations.create` for the same name (name_taken).
  let channelId = existing?.slackChannelId ?? undefined;
  let channelName = existing?.slackChannelName ?? undefined;

  if (!channelId) {
    const org = await prisma.organization.findFirst({
      where: { id: organizationId },
      select: { slug: true },
    });
    if (!org) {
      await setStatus(prisma, organizationId, "FAILED", { lastError: "Organization not found" });
      // Permanent: the org is gone.
      return { status: "failed", retryable: false };
    }

    await setStatus(prisma, organizationId, "PROVISIONING", { invitedEmail: ownerEmail });

    try {
      const created = await slackClient.createPrivateChannel(supportChannelName(org.slug));
      channelId = created.channelId;
      channelName = created.channelName;
      // Persist immediately so a retry never re-creates the channel, even if the
      // invite step below fails or the process dies before it runs.
      await setStatus(prisma, organizationId, "PROVISIONING", {
        slackChannelId: channelId,
        slackChannelName: channelName,
        invitedEmail: ownerEmail,
      });
    } catch (error) {
      await setStatus(prisma, organizationId, "FAILED", {
        lastError: error instanceof Error ? error.message : String(error),
      });
      return { status: "failed", retryable: true };
    }
  } else {
    await setStatus(prisma, organizationId, "PROVISIONING", {
      slackChannelId: channelId,
      slackChannelName: channelName,
      invitedEmail: ownerEmail,
    });
  }

  try {
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
      slackChannelId: channelId,
      slackChannelName: channelName,
      lastError: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed", retryable: true };
  }
}

/**
 * Marks a provisioning attempt failed without going near Slack. Used when the
 * worker refuses to provision at all, so the row never sits at PROVISIONING
 * with nothing coming to move it.
 */
export async function failSupportChannelProvisioning(
  prisma: PrismaClientOrTransaction,
  organizationId: string,
  lastError: string
): Promise<void> {
  await setStatus(prisma, organizationId, "FAILED", { lastError });
}

export async function unlinkSupportChannel({
  organizationId,
  prisma,
  slackClient,
}: {
  organizationId: string;
  prisma: PrismaClientOrTransaction;
  slackClient: SupportSlackClient;
}): Promise<{ status: "archived" } | { status: "not_found" }> {
  const existing = await prisma.organizationSupportChannel.findFirst({
    where: { organizationId },
  });
  if (!existing?.slackChannelId) {
    return { status: "not_found" };
  }

  await slackClient.archiveChannel(existing.slackChannelId);
  // Keep slackChannelId/slackChannelName for history; a later re-provision reuses them.
  await setStatus(prisma, organizationId, "ARCHIVED", {
    slackChannelId: existing.slackChannelId,
    slackChannelName: existing.slackChannelName,
  });
  return { status: "archived" };
}

export async function linkSupportChannel({
  organizationId,
  prisma,
  channel,
  reassign = false,
}: {
  organizationId: string;
  prisma: PrismaClientOrTransaction;
  channel: { channelId: string; channelName: string };
  reassign?: boolean;
}): Promise<{ status: "linked" } | { status: "conflict"; reason: string }> {
  const channelOwner = await prisma.organizationSupportChannel.findFirst({
    where: { slackChannelId: channel.channelId },
  });
  if (channelOwner && channelOwner.organizationId !== organizationId) {
    return {
      status: "conflict",
      reason: `Channel ${channel.channelId} is already linked to another organization`,
    };
  }

  const existing = await prisma.organizationSupportChannel.findFirst({
    where: { organizationId },
  });

  if (existing?.slackChannelId && existing.slackChannelId !== channel.channelId && !reassign) {
    return {
      status: "conflict",
      reason: `Organization is already linked to a different channel (${existing.slackChannelId})`,
    };
  }

  try {
    await prisma.organizationSupportChannel.upsert({
      where: { organizationId },
      create: {
        organizationId,
        status: "LINKED",
        slackChannelId: channel.channelId,
        slackChannelName: channel.channelName,
      },
      update: {
        status: "LINKED",
        slackChannelId: channel.channelId,
        slackChannelName: channel.channelName,
      },
    });
    return { status: "linked" };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return {
        status: "conflict",
        reason: `Channel ${channel.channelId} is already linked to another organization`,
      };
    }
    throw error;
  }
}

export type ChannelCandidate = {
  channelId: string;
  channelName: string;
  externalTeamDomain?: string;
  externalTeamEmailDomain?: string;
};

export type OrgCandidate = {
  organizationId: string;
  slug: string;
  title: string;
  ownerEmailDomain?: string;
  alreadyLinked: boolean;
};

export type MatchProposal = {
  channelId: string;
  organizationId: string;
  confidence: "high" | "medium" | "low";
  reasons: string[];
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function channelKey(channelName: string): string {
  return normalize(channelName.replace(/^cus-/, ""));
}

function orgSlugKey(slug: string): string {
  return normalize(slug.replace(/-[a-z0-9]{4}$/, ""));
}

function scoreOrgAgainstChannel(
  channel: ChannelCandidate,
  candidate: OrgCandidate
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const chKey = channelKey(channel.channelName);
  const slugKey = orgSlugKey(candidate.slug);
  const titleKey = normalize(candidate.title);

  const nameExact = chKey.length > 0 && (chKey === slugKey || chKey === titleKey);
  const nameContains =
    !nameExact &&
    chKey.length > 0 &&
    ((slugKey.length > 0 && (chKey.includes(slugKey) || slugKey.includes(chKey))) ||
      (titleKey.length > 0 && (chKey.includes(titleKey) || titleKey.includes(chKey))));

  if (nameExact) {
    score += 2;
    reasons.push("name");
  } else if (nameContains) {
    score += 1;
    reasons.push("name");
  }

  if (candidate.ownerEmailDomain) {
    const domain = candidate.ownerEmailDomain.toLowerCase();
    const channelDomains = [channel.externalTeamDomain, channel.externalTeamEmailDomain]
      .filter((d): d is string => Boolean(d))
      .map((d) => d.toLowerCase());
    if (channelDomains.includes(domain)) {
      score += 2;
      reasons.push("domain");
    }
  }

  return { score, reasons };
}

function confidenceForScore(score: number): "high" | "medium" | "low" {
  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

export function proposeOrgMatches(
  channels: ChannelCandidate[],
  orgs: OrgCandidate[]
): MatchProposal[] {
  const eligibleOrgs = orgs.filter((o) => !o.alreadyLinked);
  const proposals: MatchProposal[] = [];

  for (const channel of channels) {
    let best: { org: OrgCandidate; score: number; reasons: string[] } | undefined;
    let tie = false;

    for (const candidate of eligibleOrgs) {
      const { score, reasons } = scoreOrgAgainstChannel(channel, candidate);
      if (score <= 0) continue;

      if (!best || score > best.score) {
        best = { org: candidate, score, reasons };
        tie = false;
      } else if (score === best.score) {
        tie = true;
      }
    }

    if (!best) continue;

    const confidence = tie ? "low" : confidenceForScore(best.score);
    const reasons = tie ? [...best.reasons, "ambiguous"] : best.reasons;

    proposals.push({
      channelId: channel.channelId,
      organizationId: best.org.organizationId,
      confidence,
      reasons,
    });
  }

  return proposals;
}

export async function enqueueProvisionSupportChannel(payload: OrganizationSupportChannelPayload) {
  // Lazy import to avoid a circular dependency with commonWorker (which imports this module's schema).
  const { commonWorker } = await import("~/v3/commonWorker.server");
  await commonWorker.enqueue({
    id: `support-channel:${payload.organizationId}`,
    job: "supportChannel.provision",
    payload,
  });
}
