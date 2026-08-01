import type { CheckResult, EntryPoint } from "../types.js";
import { isTrivial } from "../triviality.js";

const ID = "request-context";

/**
 * A field name that plausibly names a TENANT: environment, organization, project or user, the four
 * things every entry point ultimately belongs to. Anchored on the root word, not just the suffix,
 * in the full and abbreviated camelCase the webapp actually writes for each: `environmentId`/
 * `envId`, `organizationId`/`organizationSlug`/`orgId`, `projectId`/`projectParam`, `userId`. A bare
 * `id`, and a resource id that happens to share the same `Id`/`Param` suffix, `batchId`,
 * `notificationId`, `chatId`, `spanParam`, `runFriendlyId`, `taskIdentifier`, does not qualify:
 * those name a resource the failure touched, not who it happened to.
 *
 * The abbreviated roots, `env` and `org`, require a suffix; the full words do not. A bare `env` is
 * ambiguous with a deployment environment name (`{ env: process.env.NODE_ENV }`), which is not a
 * tenant, and nothing in the tree relies on it being bare, so the field alone cannot qualify.
 */
const TENANT_FIELD =
  /^(environment|organization|project|user)(Id|Ids|Slug|Ref|Param|Identifier)?$|^(env|org)(Id|Ids|Slug|Ref|Param|Identifier)$/;

/**
 * Levels against the real logger (`packages/core/src/logger.ts`): `log`, `error`, `warn`, `info`,
 * `debug`, `verbose`, in that order, no `fatal` and no `trace` (the `trace` in
 * `apps/webapp/app/services/logger.server.ts` is the AsyncLocalStorage field helper, unrelated to
 * log level). `log` is level 0, the level `TRIGGER_LOG_LEVEL` never filters out, so it qualifies
 * alongside `error` and `warn`. `info`, `debug` and `verbose` do not: `info` is not reserved for
 * failure reporting, so a route can log an info line inside a catch that says nothing about the
 * catch actually handling anything, and `debug`/`verbose` are routinely dropped or sampled out
 * before anyone reads an incident.
 */
const QUALIFYING_LEVELS = new Set(["log", "error", "warn"]);

/** The level a `LogCall`'s callee was made at, e.g. `"error"` from `logger.error`. */
function logLevel(callee: string): string {
  return callee.slice(callee.lastIndexOf(".") + 1);
}

/**
 * Whether a failure here can be traced to whoever it happened to.
 *
 * Everything the platform attaches centrally is accounted for, which is what makes this worth
 * asking. `logger` pushes the http context, `{ requestId, path, host, method }`, onto every line
 * through AsyncLocalStorage, and `Logger.onError` forwards the error to Sentry. Neither carries a
 * tenant: no route calls `trace({ environmentId }, ...)`, and the builders' own boundary log is
 * `logBoundaryError(message, error, url)`, a url and an error. So an incident tells you which route
 * and which request failed, and never whose environment it was, unless the route passed the field
 * itself. 11 of 427 entry points do, naming an environment, organization, project or user; the
 * other 10 that used to be counted here only named a resource the failure touched, not a tenant.
 *
 * Every non-trivial entry point is judged, and a route that never catches fails like any other.
 * That is the whole point rather than an oversight: its failures go to the global handler, which
 * names no tenant, so it genuinely cannot say whose request broke. Passing those routes, as this
 * check used to, meant deleting every catch clause in the tree scored it 100. Excusing them as
 * not-applicable would be the same mistake in quieter clothes, since it would once again reward
 * having no failure handling to inspect.
 *
 * The consequence is a check that fails 90% of what it looks at, which is an honest reading of a
 * codebase where the fix is one platform change, tenant fields through `trace(...)` in the auth
 * path, rather than 300 route edits. Weight it accordingly, but do not read the count as noise.
 */
export const requestContext = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    if (isTrivial(ep)) {
      return { id: ID, status: "not-applicable", detail: "trivial route" };
    }
    const failurePathLogs = ep.logCalls.filter(
      (l) => l.inCatch && QUALIFYING_LEVELS.has(logLevel(l.callee))
    );
    const named = failurePathLogs.find((l) => l.fields.some((f) => TENANT_FIELD.test(f)));
    if (named) {
      const fields = named.fields.filter((f) => TENANT_FIELD.test(f));
      return { id: ID, status: "pass", detail: `failure log names ${fields.join(", ")}` };
    }
    if (failurePathLogs.length > 0) {
      return {
        id: ID,
        status: "fail",
        detail: "logs its failure without naming an environment, organization, project or user",
      };
    }
    return {
      id: ID,
      status: "fail",
      detail:
        ep.catches.length > 0
          ? "keeps its failures and records nothing about whose they were"
          : "leaves its failures to the central handler, which names no tenant",
    };
  },
};
