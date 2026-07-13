import { useFetcher } from "@remix-run/react";
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
import {
  createSupportSlackDiscoveryClient,
  linkSupportChannel,
  pickExternalTeamId,
  proposeOrgMatches,
  type ChannelCandidate,
  type MatchProposal,
  type OrgCandidate,
} from "~/services/supportSlackChannel.server";

export const loader = dashboardLoader({ authorization: { requireSuper: true } }, async () => {
  const client = createSupportSlackDiscoveryClient(env.SLACK_BOT_TOKEN);
  if (!client) {
    return typedjson({
      notConfigured: true as const,
      channels: [],
      proposals: [],
      orgs: [],
      linkedOrgTitleByChannelId: {} as Record<string, string>,
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
        select: { slackChannelId: true, slackChannelName: true },
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

  // Maps a Slack channel id to the org title it's already linked to, so the
  // table can show per-channel link status. Built separately from
  // `OrgCandidate` since that type only carries a boolean for matching.
  const linkedOrgTitleByChannelId: Record<string, string> = {};
  for (const organization of organizations) {
    if (organization.supportChannel?.slackChannelId) {
      linkedOrgTitleByChannelId[organization.supportChannel.slackChannelId] = organization.title;
    }
  }

  const proposals = proposeOrgMatches(channels, orgs);

  return typedjson({
    notConfigured: false as const,
    channels,
    proposals,
    orgs,
    linkedOrgTitleByChannelId,
  });
});

const ActionBody = z.object({
  _action: z.enum(["link", "reassign"]),
  channelId: z.string(),
  channelName: z.string(),
  organizationId: z.string(),
});

export const action = dashboardAction(
  { authorization: { requireSuper: true } },
  async ({ request }) => {
    const formData = await request.formData();
    const parsed = ActionBody.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return typedjson({ error: "Invalid form submission" }, { status: 400 });
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
  const { notConfigured, channels, proposals, orgs, linkedOrgTitleByChannelId } =
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
                  linkedOrgTitle={linkedOrgTitleByChannelId[channel.channelId]}
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
  linkedOrgTitle,
}: {
  channel: LoaderChannel;
  proposal: MatchProposal | undefined;
  orgs: LoaderOrg[];
  linkedOrgTitle: string | undefined;
}) {
  const fetcher = useFetcher<{ error?: string; success?: boolean }>();
  const defaultOrganizationId = proposal?.organizationId ?? orgs[0]?.organizationId ?? "";
  const isBusy = fetcher.state !== "idle";

  return (
    <TableRow>
      <TableCell>
        <span className="font-mono text-xs text-text-bright">{channel.channelName}</span>
      </TableCell>
      <TableCell>
        {linkedOrgTitle ? (
          <span className="text-xs text-text-dimmed">Linked: {linkedOrgTitle}</span>
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
            defaultValue={defaultOrganizationId}
            className="h-8 rounded border border-charcoal-700 bg-background-hover px-2 text-xs text-text-bright"
          >
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
            disabled={isBusy}
          >
            Approve
          </Button>
          <Button
            type="submit"
            name="_action"
            value="reassign"
            variant="tertiary/small"
            disabled={isBusy}
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
      <TableCell />
    </TableRow>
  );
}
