import type {
  AuditLogEventPage,
  AuditLogEventQuery,
  AuditLogListedAction,
  AuditLogListedEvent,
  AuditLogSource,
} from "@trigger.dev/plugins";
import { boundedIn, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { z } from "zod";
import {
  AUDIT_LOG_ACTION_LABELS,
  auditLogActions,
  AUDIT_LOG_DEFAULT_PERIOD,
  AUDIT_LOG_VIA_LABELS,
  type AuditLogFilterCategory,
  DEFAULT_AUDIT_LOG_FILTER_CATEGORY,
  isAuditLogFilterCategory,
  isAuditLogVia,
  isListedAuditLogAction,
} from "~/components/auditLogs/auditLogEvents";
import { dateFromString, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import type { PrismaReplicaClient } from "~/db.server";
import {
  auditLogErrorKind,
  clampToVisibilityWindow,
  EARLIEST_EVENT,
} from "~/services/auditLogs/auditEventsApi.server";
import { obfuscateApiKey } from "~/utils/apiKeys";
import { credentialFilter, parseCredentialReference } from "./auditLogCredentials.server";
import { userName } from "./auditLogMenus.server";

const AUDIT_LOG_PAGE_SIZE = 50;

/** A URL value, or nothing when it's missing or out of bounds: a bad link shows the log unfiltered. */
const param = (max: number) => z.string().trim().max(max).optional().catch(undefined);

/** The page's URL. Values the page doesn't know are ignored rather than rejected. */
export const AuditLogSearchParams = z.object({
  category: param(32),
  action: param(64),
  actor: param(128),
  project: param(128),
  environment: param(128),
  target: param(256),
  key: param(256),
  credential: param(160),
  via: param(16),
  period: param(32),
  from: param(32),
  to: param(32),
  cursor: param(1024),
});
export type AuditLogSearchParams = z.infer<typeof AuditLogSearchParams>;

/** The time range's `from` and `to` when set to something that isn't a date. */
export function invalidTimeParams(params: URLSearchParams): Array<"from" | "to"> {
  return (["from", "to"] as const).filter((name) => {
    const value = params.get(name);
    return value !== null && Number.isNaN(dateFromString(value)?.getTime() ?? Number.NaN);
  });
}

export type AuditLogFilters = {
  category: AuditLogFilterCategory;
  includeReads: boolean;
  action?: AuditLogListedAction;
  actorId?: string;
  projectId?: string;
  environmentId?: string;
  target?: string;
  keyLast4?: string;
  /** A credential reference, e.g. `root:<environmentId>`; see auditLogCredentials. */
  credential?: string;
  /** How the events came in: the dashboard, the API… */
  via?: AuditLogSource;
};

/** Who acted, as the page shows it. Never a staff member's identity. */
export type AuditLogActorView =
  | {
      kind: "user";
      id: string;
      name: string;
      email: string | null;
      avatarUrl: string | null;
      /** As the row shows it: the name, `PAT · ci-deploy (Ada)`, or `Trigger.dev support (as Ada)`. */
      label: string;
      /** Trigger.dev support acted while impersonating this user. */
      bySupport: boolean;
      /** The user acted with one of their personal access tokens. */
      withPat: boolean;
    }
  | { kind: "credential"; label: string; credential: "key" | "token" }
  | { kind: "run" | "support" | "infrastructure" | "system"; label: string };

export type AuditLogEventView = {
  id: string;
  occurredAt: Date;
  category: AuditLogListedEvent["category"];
  action: AuditLogListedAction;
  actionLabel: string;
  actor: AuditLogActorView;
  /**
   * The credential the request used, in words: `Secret API key (prod), last 4 k9Qz`,
   * `Personal access token "ci-deploy", owner Ada`, `Support access session`.
   */
  credential: string | null;
  /** The last 4 of the key or token the request used, to find every event involving it. */
  credentialLast4: string | null;
  target: { type: string; id: string | null; name: string | null };
  project: { id: string; name: string } | null;
  environment: {
    id: string;
    type: RuntimeEnvironmentType;
    branchName: string | null;
    userName: string | null;
  } | null;
  /** How the request reached us: dashboard, CLI, API… */
  client: string;
  ip: string | null;
  /** Where the IP is: country and network. Only when the IP is shown. */
  location: { countryCode: string | null; asn: number | null; asName: string | null } | null;
  userAgent: string | null;
  changes: AuditLogListedEvent["changes"];
  requestId: string | null;
  /**
   * The deployment a build's request was for, to link to: its short code and where it lives. Null
   * when the event has none, or the deployment isn't this org's or no longer exists.
   */
  deployment: {
    friendlyId: string;
    version: string;
    shortCode: string;
    projectSlug: string;
    environmentSlug: string;
  } | null;
  /** The event as the host lists it, for the raw JSON view. */
  raw: AuditLogListedEvent;
};

export type AuditLogPageData = {
  filters: AuditLogFilters;
  /**
   * The time range the events were read for, in milliseconds: a relative range ("7 days") resolved
   * when the page loaded. The key summary reads this exact range, so it covers the same events.
   */
  range: { from: number; to: number };
  events: AuditLogEventView[];
  nextCursor: string | null;
  /** Set when the store couldn't answer, or rejected the query. */
  error: string | null;
  /**
   * The picked credential is a personal access token with events in this organization, so its name
   * may be shown. A member's token used only in other organizations is never named here.
   */
  patActedHere?: boolean;
};

type ListEvents = (query: AuditLogEventQuery) => Promise<AuditLogEventPage>;

export function auditLogFilters(searchParams: AuditLogSearchParams): AuditLogFilters {
  const category = isAuditLogFilterCategory(searchParams.category)
    ? searchParams.category
    : DEFAULT_AUDIT_LOG_FILTER_CATEGORY;
  // An event outside the category would never match. A read can always be picked as the event.
  const action =
    isListedAuditLogAction(searchParams.action) &&
    auditLogActions(category, true).includes(searchParams.action)
      ? searchParams.action
      : undefined;
  // A pasted key works too: the last 4 characters are what's stored.
  const keyLast4 =
    searchParams.key && searchParams.key.length >= 4 ? searchParams.key.slice(-4) : undefined;
  const credential = parseCredentialReference(searchParams.credential)
    ? searchParams.credential
    : undefined;
  // Reads are frequent, so they're left out, except for one key or token: what it read matters.
  const includeReads = Boolean(credential || keyLast4);

  return {
    category,
    includeReads,
    action,
    actorId: searchParams.actor || undefined,
    projectId: searchParams.project || undefined,
    environmentId: searchParams.environment || undefined,
    target: searchParams.target || undefined,
    keyLast4,
    credential,
    via: isAuditLogVia(searchParams.via) ? searchParams.via : undefined,
  };
}

/** The plugin query for a page of the org's log. */
export function auditLogQuery(
  organizationId: string,
  filters: AuditLogFilters,
  searchParams: AuditLogSearchParams
): AuditLogEventQuery {
  const { from, to } = timeFilterFromTo({
    period: searchParams.period,
    from: searchParams.from,
    to: searchParams.to,
    defaultPeriod: AUDIT_LOG_DEFAULT_PERIOD,
  });

  return {
    organizationId,
    from,
    to,
    // `all` lists every action, so it needs no action filter.
    actions: filters.action
      ? [filters.action]
      : auditLogActions(filters.category, filters.includeReads),
    actorId: filters.actorId,
    projectId: filters.projectId,
    environmentId: filters.environmentId,
    targetName: filters.target,
    keyLast4: filters.keyLast4,
    sources: filters.via ? [filters.via] : undefined,
    cursor: searchParams.cursor,
    limit: AUDIT_LOG_PAGE_SIZE,
  };
}

/** How the request reached us. The client behind an API call is the detail panel's to name. */
export function auditLogClient(source: AuditLogListedEvent["source"]): string {
  return AUDIT_LOG_VIA_LABELS[source];
}

/**
 * One page of an org's audit log, with the names the page shows. Ids are stored on events and
 * resolved here, at read time.
 */
export class AuditLogPresenter {
  constructor(
    private readonly replica: PrismaReplicaClient,
    private readonly listEvents: ListEvents
  ) {}

  async call(
    organizationId: string,
    searchParams: AuditLogSearchParams
  ): Promise<AuditLogPageData> {
    const filters = auditLogFilters(searchParams);
    const query = auditLogQuery(organizationId, filters, searchParams);
    const range = { from: query.from.getTime(), to: query.to.getTime() };
    const { from, to } = await clampToVisibilityWindow(organizationId, query);
    if (from >= to) {
      return {
        filters,
        range,
        events: [],
        nextCursor: null,
        error: "The start of the time range must be before its end.",
      };
    }

    const reference = parseCredentialReference(filters.credential);
    const credential = reference ? credentialFilter(reference) : undefined;

    let page: AuditLogEventPage;
    try {
      page = await this.listEvents({ ...query, from, to, credential });
    } catch (error) {
      const kind = auditLogErrorKind(error);
      if (kind === "invalid_query") {
        return {
          filters,
          range,
          events: [],
          nextCursor: null,
          error: "These filters aren't valid.",
        };
      }
      if (kind === "unavailable") {
        return {
          filters,
          range,
          events: [],
          nextCursor: null,
          error: "The audit log is temporarily unavailable. Please try again.",
        };
      }
      throw error;
    }

    return {
      filters,
      range,
      events: await this.#toViews(organizationId, page.events),
      nextCursor: page.nextCursor,
      error: null,
      patActedHere:
        reference?.kind === "pat" && credential
          ? page.events.length > 0 || (await this.#actedHere(organizationId, credential))
          : undefined,
    };
  }

  /** Whether the credential has any event this organization can see, whatever the filters. */
  async #actedHere(
    organizationId: string,
    credential: NonNullable<AuditLogEventQuery["credential"]>
  ): Promise<boolean> {
    const { from, to } = await clampToVisibilityWindow(organizationId, {
      from: EARLIEST_EVENT,
      to: new Date(),
    });
    try {
      const page = await this.listEvents({
        organizationId,
        from,
        to,
        credential,
        limit: 1,
      });
      return page.events.length > 0;
    } catch {
      // Unknown: don't name it.
      return false;
    }
  }

  async #toViews(
    organizationId: string,
    events: AuditLogListedEvent[]
  ): Promise<AuditLogEventView[]> {
    const ids = (pick: (event: AuditLogListedEvent) => string | null | undefined) =>
      Array.from(new Set(events.map(pick).filter((id): id is string => Boolean(id))));

    const userIds = Array.from(
      new Set([
        ...ids((event) => (event.actor.type === "user" ? event.actor.id : null)),
        ...ids(supportSessionUserId),
      ])
    );
    const patIds = ids((event) => (event.credential?.kind === "pat" ? event.credential.id : null));
    const oatIds = ids((event) => (event.credential?.kind === "oat" ? event.credential.id : null));
    const projectIds = ids((event) => event.projectId);
    const environmentIds = ids((event) => event.environmentId);
    const deploymentIds = ids((event) => event.origin?.deploymentId);

    const [users, pats, oats, projects, environments, deployments] = await Promise.all([
      userIds.length
        ? this.replica.user.findMany({
            where: { id: { in: boundedIn(userIds) } },
            select: { id: true, name: true, displayName: true, email: true, avatarUrl: true },
          })
        : [],
      patIds.length
        ? this.replica.personalAccessToken.findMany({
            where: { id: { in: boundedIn(patIds) } },
            select: { id: true, name: true },
          })
        : [],
      // Scoped to the org: an org access token belongs to one.
      oatIds.length
        ? this.replica.organizationAccessToken.findMany({
            where: { id: { in: boundedIn(oatIds) }, organizationId },
            select: { id: true, name: true },
          })
        : [],
      projectIds.length
        ? this.replica.project.findMany({
            where: { id: { in: boundedIn(projectIds) }, organizationId },
            select: { id: true, name: true },
          })
        : [],
      environmentIds.length
        ? this.replica.runtimeEnvironment.findMany({
            where: { id: { in: boundedIn(environmentIds) }, organizationId },
            select: {
              id: true,
              type: true,
              branchName: true,
              orgMember: { select: { user: { select: { name: true, displayName: true } } } },
            },
          })
        : [],
      // Scoped to the org: an event's deployment id is a friendly id, unique per deployment.
      deploymentIds.length
        ? this.replica.workerDeployment.findMany({
            where: { friendlyId: { in: boundedIn(deploymentIds) }, project: { organizationId } },
            select: {
              friendlyId: true,
              version: true,
              shortCode: true,
              project: { select: { slug: true } },
              environment: { select: { slug: true } },
            },
          })
        : [],
    ]);

    const usersById = new Map(users.map((user) => [user.id, user]));
    const patNames = new Map(pats.map((pat) => [pat.id, pat.name]));
    const oatNames = new Map(oats.map((oat) => [oat.id, oat.name]));
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const deploymentsById = new Map(
      deployments.map((deployment) => [
        deployment.friendlyId,
        {
          friendlyId: deployment.friendlyId,
          version: deployment.version,
          shortCode: deployment.shortCode,
          projectSlug: deployment.project.slug,
          environmentSlug: deployment.environment.slug,
        },
      ])
    );
    const environmentsById = new Map(
      environments.map((environment) => [environment.id, environment])
    );

    return events.map((event) => {
      const actor = actorView(event, usersById, patNames, oatNames);
      const environment = event.environmentId
        ? environmentsById.get(event.environmentId)
        : undefined;
      const project = event.projectId ? projectsById.get(event.projectId) : undefined;

      return {
        id: event.id,
        occurredAt: event.occurredAt,
        category: event.category,
        action: event.action,
        actionLabel: AUDIT_LOG_ACTION_LABELS[event.action] ?? event.action,
        actor,
        credential: credentialDescription(event, actor, patNames, oatNames, deploymentsById),
        // Support's credential is never listed: nothing to link.
        credentialLast4:
          event.actor.type === "support" || event.source === "staff"
            ? null
            : (event.credential?.last4 ?? null),
        target: targetView(event, usersById),
        project: project ?? null,
        environment: environment
          ? {
              id: environment.id,
              type: environment.type,
              branchName: environment.branchName,
              userName: environment.orgMember ? userName(environment.orgMember.user) : null,
            }
          : null,
        client: auditLogClient(event.source),
        ip: event.endpoint?.ip ?? null,
        location: event.endpoint?.location ?? null,
        userAgent: event.endpoint?.userAgent ?? null,
        changes: event.changes,
        requestId: event.requestId,
        deployment: event.origin?.deploymentId
          ? (deploymentsById.get(event.origin.deploymentId) ?? null)
          : null,
        raw: event,
      };
    });
  }
}

/** The credential the request used, in words, for the detail panel. */
function credentialDescription(
  event: AuditLogListedEvent,
  actor: AuditLogActorView,
  patNames: Map<string, string>,
  oatNames: Map<string, string>,
  deploymentsById: Map<string, { version: string }>
): string | null {
  if (event.actor.type === "support" || event.source === "staff") return "Support access session";
  if (event.actor.type === "trigger_infra") {
    const deploymentId = event.origin?.deploymentId;
    if (!deploymentId) return null;
    return `Deployment ${deploymentsById.get(deploymentId)?.version ?? deploymentId}`;
  }
  const credential = event.credential;
  if (!credential) return null;

  switch (credential.kind) {
    case "root_api_key":
    case "additional_api_key": {
      // The masked key itself is the actor's label.
      const kind = credential.kind === "root_api_key" ? "Secret API key" : "Additional API key";
      return event.environmentType
        ? `${kind} (${ENVIRONMENT_SHORT_NAMES[event.environmentType]})`
        : kind;
    }
    case "pat": {
      const name = credential.id ? patNames.get(credential.id) : undefined;
      const token = name ? `Personal access token "${name}"` : "Personal access token";
      return actor.kind === "user" ? `${token}, owner ${actor.name}` : token;
    }
    case "oat": {
      const name = credential.id ? oatNames.get(credential.id) : undefined;
      return name ? `Organization access token "${name}"` : "Organization access token";
    }
    case "public_jwt":
      return "Public access token";
    case "run_token":
      return "Run token";
  }
}

function actorView(
  event: AuditLogListedEvent,
  usersById: Map<string, UserRow>,
  patNames: Map<string, string>,
  oatNames: Map<string, string>
): AuditLogActorView {
  const { actor } = event;
  switch (actor.type) {
    case "user": {
      const user = actor.id ? usersById.get(actor.id) : undefined;
      const name = user ? userName(user) : "Former member";
      // A user's change with a staff source was made by support impersonating them.
      const bySupport = event.source === "staff";
      // A personal access token is always its owner's, so the user is the actor and the PAT is how.
      const withPat = !bySupport && event.credential?.kind === "pat";
      const patName =
        withPat && event.credential?.id ? patNames.get(event.credential.id) : undefined;
      const label = bySupport
        ? `Trigger.dev support (as ${name})`
        : withPat
          ? patName
            ? `PAT · ${patName} (${name})`
            : `PAT (${name})`
          : name;
      return {
        kind: "user",
        id: user?.id ?? actor.id ?? "",
        name,
        email: user?.email ?? null,
        avatarUrl: user?.avatarUrl ?? null,
        label,
        bySupport,
        withPat,
      };
    }
    case "api_key":
    case "pat":
    case "oat":
      return {
        kind: "credential",
        label: credentialActorLabel(event, patNames, oatNames),
        credential: actor.type === "api_key" ? "key" : "token",
      };
    case "run":
      return { kind: "run", label: actor.id ? `Run ${actor.id}` : "A task run" };
    // Who at Trigger.dev acted is never shown, only that support did.
    case "support":
      return { kind: "support", label: "Trigger.dev support" };
    // Keys Trigger.dev mints for its own work act as infrastructure: a build's deploy key, and
    // the platform's keys for Vercel promotion and preview branch archiving.
    case "trigger_infra":
      return { kind: "infrastructure", label: "Trigger.dev infrastructure" };
    case "system":
      return { kind: "system", label: "Trigger.dev" };
  }
}

type UserRow = {
  id: string;
  name: string | null;
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
};

const ENVIRONMENT_SHORT_NAMES: Record<RuntimeEnvironmentType, string> = {
  PRODUCTION: "prod",
  STAGING: "staging",
  PREVIEW: "preview",
  DEVELOPMENT: "dev",
};

/** A credential that acted, short: `tr_prod_••••••••k9Qz`, `Org token · ci-sync`. */
function credentialActorLabel(
  event: AuditLogListedEvent,
  patNames: Map<string, string>,
  oatNames: Map<string, string>
): string {
  const credential = event.credential;
  switch (credential?.kind) {
    case "root_api_key":
    case "additional_api_key": {
      // Masked the way the dashboard shows keys elsewhere: `tr_prod_••••••••k9Qz`.
      const root = credential.kind === "root_api_key";
      if (!credential.last4) return root ? "Root key" : "Additional key";
      return event.environmentType
        ? obfuscateApiKey(event.environmentType, credential.last4, root ? "root" : "additional")
        : `••••••••${credential.last4}`;
    }
    case "pat": {
      const name = credential.id ? patNames.get(credential.id) : undefined;
      return name ? `PAT · ${name}` : "PAT";
    }
    case "oat": {
      const name = credential.id ? oatNames.get(credential.id) : undefined;
      return name ? `Org token · ${name}` : "Org token";
    }
    case "public_jwt":
      return "Public access token";
    case "run_token":
      return "Run token";
    case undefined:
      return "API key";
  }
}

/** A support session is recorded against the user support signed in as. */
function supportSessionUserId(event: AuditLogListedEvent): string | null {
  return event.category === "support" && event.target.type === "user" ? event.target.id : null;
}

/** The target, with the user support signed in as named for a support session. */
function targetView(
  event: AuditLogListedEvent,
  usersById: Map<string, UserRow>
): AuditLogEventView["target"] {
  const userId = supportSessionUserId(event);
  if (!userId) return event.target;
  const user = usersById.get(userId);
  return { ...event.target, name: user ? userName(user) : "Former member" };
}
