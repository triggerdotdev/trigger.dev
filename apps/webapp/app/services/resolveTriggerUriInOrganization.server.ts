/**
 * `trigger://` URIs resolved across one organization. The agent reads every project the reader
 * can see, so a citation's own project and environment decide the path — not the route's. Each
 * URI is gated here by live membership and dev-environment ownership, and anything that fails
 * resolves to nothing rather than to an error that would reveal it exists.
 */
import { safeParseTriggerUri, type ParsedTriggerUri } from "@internal/dashboard-agent-contracts";
import { boundedIn } from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { environmentVisibilityFilter } from "~/services/locateAgentObject.server";
import {
  resolveTriggerUri,
  type ResolvedTriggerUri,
  type TriggerUriScope,
} from "~/services/resolveTriggerUri.server";

/** The session's user and the organization the request is scoped to. Both are re-checked here. */
export type TriggerUriActor = { userId: string; organizationId: string };

type VisibleEnvironment = {
  id: string;
  slug: string;
  project: { id: string; slug: string; externalRef: string };
  organization: { slug: string };
};

export async function resolveTriggerUrisInOrganization(
  actor: TriggerUriActor,
  uris: string[]
): Promise<Map<string, ResolvedTriggerUri | null>> {
  const resolved = new Map<string, ResolvedTriggerUri | null>(uris.map((uri) => [uri, null]));

  const parsedByUri = new Map<string, ParsedTriggerUri>();
  for (const uri of uris) {
    const parsed = safeParseTriggerUri(uri);
    if (parsed.success) parsedByUri.set(uri, parsed.data);
  }
  if (parsedByUri.size === 0) return resolved;

  const environments = await findVisibleEnvironments(actor, [
    ...new Set([...parsedByUri.values()].map((parsed) => parsed.environmentId)),
  ]);

  const inScope = new Map<string, VisibleEnvironment>();
  for (const [uri, parsed] of parsedByUri) {
    const environment = environments.get(parsed.environmentId);
    if (!environment || environment.project.externalRef !== parsed.projectRef) continue;
    inScope.set(uri, environment);
  }

  const repositories = await findRepositories(
    new Set(
      [...inScope]
        .filter(([uri]) => parsedByUri.get(uri)!.kind === "source")
        .map(([, environment]) => environment.project.id)
    )
  );

  for (const [uri, environment] of inScope) {
    const scope: TriggerUriScope = {
      id: environment.id,
      slug: environment.slug,
      project: environment.project,
      organization: environment.organization,
      repository: repositories.get(environment.project.id) ?? null,
    };
    resolved.set(uri, resolveTriggerUri(scope, uri));
  }

  return resolved;
}

/** The visible environments of `environmentIds`, plus a live-membership check no other caller needs. */
async function findVisibleEnvironments(
  actor: TriggerUriActor,
  environmentIds: string[]
): Promise<Map<string, VisibleEnvironment>> {
  const environments = await $replica.runtimeEnvironment.findMany({
    where: {
      id: { in: boundedIn(environmentIds) },
      ...environmentVisibilityFilter(actor, {
        organization: { deletedAt: null, members: { some: { userId: actor.userId } } },
      }),
    },
    select: {
      id: true,
      slug: true,
      project: { select: { id: true, slug: true, externalRef: true } },
      organization: { select: { slug: true } },
    },
  });
  return new Map(environments.map((environment) => [environment.id, environment]));
}

/** Only a source URI needs the connected repository, so a batch without one skips the read. */
async function findRepositories(projectIds: Set<string>) {
  if (projectIds.size === 0) return new Map<string, { fullName: string }>();

  const connected = await $replica.connectedGithubRepository.findMany({
    where: {
      projectId: { in: boundedIn([...projectIds]) },
      repository: { installation: { deletedAt: null, suspendedAt: null } },
    },
    select: { projectId: true, repository: { select: { fullName: true } } },
  });

  // A project can only be connected to one repository (unique on `projectId`).
  return new Map(connected.map((row) => [row.projectId, row.repository]));
}
