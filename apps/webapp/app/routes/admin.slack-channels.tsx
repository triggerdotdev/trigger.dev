import { useFetcher } from "@remix-run/react";
import { useState } from "react";
import type { OrganizationSupportChannelStatus } from "@trigger.dev/database";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Button } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { getCurrentPlan } from "~/services/platform.v3.server";
import {
  createSupportSlackClient,
  createSupportSlackDiscoveryClient,
  isDowngradedLink,
  isPaidPlan,
  linkSupportChannel,
  pickExternalTeamId,
  proposeOrgMatches,
  unlinkSupportChannel,
  type ChannelCandidate,
  type MatchProposal,
  type OrgCandidate,
} from "~/services/supportSlackChannel.server";

// No-proposal rows default to this rather than the first org in the list, so
// approving always needs a deliberate pick. Rejected server-side too.
const UNSET_ORGANIZATION_ID = "__unset__";

type LinkedChannelInfo = {
  organizationId: string;
  title: string;
  status: OrganizationSupportChannelStatus;
  downgraded: boolean;
};

export const loader = dashboardLoader({ authorization: { requireSuper: true } }, async () => {
  const client = createSupportSlackDiscoveryClient(env.SLACK_BOT_TOKEN);
  if (!client) {
    return typedjson({
      notConfigured: true as const,
      channels: [],
      proposals: [],
      orgs: [],
      linkedChannelInfoByChannelId: {} as Record<string, LinkedChannelInfo>,
    });
  }

  const ownTeamId = await client.ownTeamId();
  const rawChannels = await client.listCustomerChannels();

  const teamDomainCache = new Map<string, { domain?: string; emailDomain?: string }>();
  const channels: ChannelCandidate[] = [];
  for (const rawChannel of rawChannels) {
    const externalTeamId = pickExternalTeamId(rawChannel.connectedTeamIds, ownTeamId);
    let domains: { domain?: string; emailDomain?: string } = {};
    if (externalTeamId) {
      const cached = teamDomainCache.get(externalTeamId);
      if (cached) {
        domains = cached;
      } else {
        domains = await client.getTeamDomains(externalTeamId);
        teamDomainCache.set(externalTeamId, domains);
      }
    }
    channels.push({
      channelId: rawChannel.channelId,
      channelName: rawChannel.channelName,
      externalTeamDomain: domains.domain,
      externalTeamEmailDomain: domains.emailDomain,
    });
  }

  const organizations = await prisma.organization.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      slug: true,
      title: true,
      supportChannel: {
        select: { slackChannelId: true, slackChannelName: true, status: true },
      },
      members: {
        where: { role: "ADMIN" },
        take: 1,
        orderBy: { createdAt: "asc" },
        select: { user: { select: { email: true } } },
      },
    },
  });

  const orgs: OrgCandidate[] = organizations.map((organization) => {
    const ownerEmail = organization.members[0]?.user.email;
    const ownerEmailDomain = ownerEmail?.split("@")[1];
    return {
      organizationId: organization.id,
      slug: organization.slug,
      title: organization.title,
      ownerEmailDomain,
      alreadyLinked: Boolean(organization.supportChannel?.slackChannelId),
    };
  });

  // Maps a Slack channel id to its linked org + status, so the table can show
  // per-channel link status and a downgraded flag. Built separately from
  // `OrgCandidate` since that type only carries a boolean for matching.
  // Plan lookups are cached per org since the same org can only appear once
  // here, but this keeps the pattern safe if that ever changes.
  const planCache = new Map<string, boolean>();
  async function isOrgPaying(organizationId: string): Promise<boolean> {
    const cached = planCache.get(organizationId);
    if (cached !== undefined) {
      return cached;
    }
    const plan = await getCurrentPlan(organizationId);
    const paying = isPaidPlan(plan);
    planCache.set(organizationId, paying);
    return paying;
  }

  const linkedChannelInfoByChannelId: Record<string, LinkedChannelInfo> = {};
  for (const organization of organizations) {
    const supportChannel = organization.supportChannel;
    if (!supportChannel?.slackChannelId) {
      continue;
    }
    const isPaying = await isOrgPaying(organization.id);
    linkedChannelInfoByChannelId[supportChannel.slackChannelId] = {
      organizationId: organization.id,
      title: organization.title,
      status: supportChannel.status,
      downgraded: isDowngradedLink({ hasChannel: true, isPaying }),
    };
  }

  const proposals = proposeOrgMatches(channels, orgs);

  return typedjson({
    notConfigured: false as const,
    channels,
    proposals,
    orgs,
    linkedChannelInfoByChannelId,
  });
});

const LinkActionBody = z.object({
  _action: z.enum(["link", "reassign"]),
  channelId: z.string(),
  channelName: z.string(),
  organizationId: z.string().refine((value) => value !== UNSET_ORGANIZATION_ID, {
    message: "Select an organization",
  }),
});

const UnlinkActionBody = z.object({
  _action: z.literal("unlink"),
  organizationId: z.string(),
});

const ActionBody = z.union([LinkActionBody, UnlinkActionBody]);

export const action = dashboardAction(
  { authorization: { requireSuper: true } },
  async ({ request }) => {
    const formData = await request.formData();
    const parsed = ActionBody.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return typedjson({ error: "Invalid form submission" }, { status: 400 });
    }

    if (parsed.data._action === "unlink") {
      const { organizationId } = parsed.data;
      const slackClient = createSupportSlackClient(env.SLACK_BOT_TOKEN);
      if (!slackClient) {
        return typedjson({ error: "Slack is not configured" }, { status: 400 });
      }

      const result = await unlinkSupportChannel({ organizationId, prisma, slackClient });
      if (result.status === "not_found") {
        return typedjson(
          { error: "No linked channel found for this organization" },
          { status: 404 }
        );
      }

      return typedjson({ success: true as const });
    }

    const { _action, channelId, channelName, organizationId } = parsed.data;

    const result = await linkSupportChannel({
      organizationId,
      prisma,
      channel: { channelId, channelName },
      reassign: _action === "reassign",
    });

    if (result.status === "conflict") {
      return typedjson({ error: result.reason }, { status: 409 });
    }

    return typedjson({ success: true as const });
  }
);

type LoaderChannel = ChannelCandidate;
type LoaderOrg = OrgCandidate & { organizationId: string };

export default function AdminSlackChannelsRoute() {
  const { notConfigured, channels, proposals, orgs, linkedChannelInfoByChannelId } =
    useTypedLoaderData<typeof loader>();

  if (notConfigured) {
    return (
      <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
        <Paragraph className="text-text-dimmed">
          Slack is not configured (missing SLACK_BOT_TOKEN). Support channel discovery is
          unavailable.
        </Paragraph>
      </main>
    );
  }

  const proposalByChannelId = new Map<string, MatchProposal>(
    proposals.map((proposal) => [proposal.channelId, proposal])
  );

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
      <div className="space-y-4">
        <Paragraph className="text-text-dimmed">
          {channels.length} customer Slack Connect channel{channels.length === 1 ? "" : "s"} found.
        </Paragraph>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Channel</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Proposed org</TableHeaderCell>
              <TableHeaderCell>Confidence</TableHeaderCell>
              <TableHeaderCell></TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {channels.length === 0 ? (
              <TableBlankRow colSpan={5}>
                <Paragraph>No customer Slack Connect channels found</Paragraph>
              </TableBlankRow>
            ) : (
              channels.map((channel) => (
                <ChannelRow
                  key={channel.channelId}
                  channel={channel}
                  proposal={proposalByChannelId.get(channel.channelId)}
                  orgs={orgs}
                  linkedInfo={linkedChannelInfoByChannelId[channel.channelId]}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </main>
  );
}

function ChannelRow({
  channel,
  proposal,
  orgs,
  linkedInfo,
}: {
  channel: LoaderChannel;
  proposal: MatchProposal | undefined;
  orgs: LoaderOrg[];
  linkedInfo: LinkedChannelInfo | undefined;
}) {
  const fetcher = useFetcher<{ error?: string; success?: boolean }>();
  const unlinkFetcher = useFetcher<{ error?: string; success?: boolean }>();
  const [organizationId, setOrganizationId] = useState(
    proposal?.organizationId ?? UNSET_ORGANIZATION_ID
  );
  const isBusy = fetcher.state !== "idle";
  const isUnlinking = unlinkFetcher.state !== "idle";
  const hasNoOrgPicked = organizationId === UNSET_ORGANIZATION_ID;

  return (
    <TableRow>
      <TableCell>
        <span className="font-mono text-xs text-text-bright">{channel.channelName}</span>
      </TableCell>
      <TableCell>
        {linkedInfo ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-dimmed">
              Linked: {linkedInfo.title} ({linkedInfo.status})
            </span>
            {linkedInfo.downgraded && (
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs font-medium text-amber-400">
                Downgraded
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-text-dimmed">Unlinked</span>
        )}
      </TableCell>
      <TableCell>
        <fetcher.Form method="post" className="flex items-center gap-2">
          <input type="hidden" name="channelId" value={channel.channelId} />
          <input type="hidden" name="channelName" value={channel.channelName} />
          <select
            name="organizationId"
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            className="h-8 rounded border border-charcoal-700 bg-background-hover px-2 text-xs text-text-bright"
          >
            <option value={UNSET_ORGANIZATION_ID}>Select an organization…</option>
            {orgs.map((org) => (
              <option key={org.organizationId} value={org.organizationId}>
                {org.title} ({org.slug})
              </option>
            ))}
          </select>
          <Button
            type="submit"
            name="_action"
            value="link"
            variant="secondary/small"
            disabled={isBusy || hasNoOrgPicked}
          >
            Approve
          </Button>
          <Button
            type="submit"
            name="_action"
            value="reassign"
            variant="tertiary/small"
            disabled={isBusy || hasNoOrgPicked}
          >
            Reassign
          </Button>
        </fetcher.Form>
        {fetcher.data?.error && (
          <Paragraph variant="extra-small" className="mt-1 text-red-400">
            {fetcher.data.error}
          </Paragraph>
        )}
      </TableCell>
      <TableCell>
        {proposal ? (
          <span className="text-xs text-text-dimmed">
            {proposal.confidence} ({proposal.reasons.join(", ")})
          </span>
        ) : (
          <span className="text-xs text-text-dimmed">—</span>
        )}
      </TableCell>
      <TableCell>
        {linkedInfo && (
          <unlinkFetcher.Form
            method="post"
            onSubmit={(e) => {
              if (
                !window.confirm(
                  "Archive this Slack support channel and unlink it from the organization? The customer will lose access."
                )
              ) {
                e.preventDefault();
              }
            }}
          >
            <input type="hidden" name="organizationId" value={linkedInfo.organizationId} />
            <Button
              type="submit"
              name="_action"
              value="unlink"
              variant="danger/small"
              disabled={isUnlinking}
            >
              Unlink
            </Button>
          </unlinkFetcher.Form>
        )}
        {unlinkFetcher.data?.error && (
          <Paragraph variant="extra-small" className="mt-1 text-red-400">
            {unlinkFetcher.data.error}
          </Paragraph>
        )}
      </TableCell>
    </TableRow>
  );
}
