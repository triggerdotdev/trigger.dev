import type { CheckResult, EntryPoint } from "../types.js";
import { isTrivial } from "../triviality.js";

const ID = "request-context";

/**
 * A field name that says which tenant, request or resource the failure belongs to. Matched on the
 * suffix, in the camelCase the webapp writes: `environmentId`, `organizationSlug`, `runFriendlyId`,
 * `projectParam`, `taskIdentifier`. Lowercase `id` inside a word is not a suffix, so `valid` and
 * `paid` do not qualify.
 */
const IDENTIFIER_FIELD = /^(id|ids|slug|ref)$|[a-z](Id|Ids|Slug|Ref|Param|Identifier)$/;

/**
 * Whether a failure here can be traced to whoever it happened to.
 *
 * Everything the platform attaches centrally is accounted for, which is what makes this worth
 * asking. `logger` pushes the http context, `{ requestId, path, host, method }`, onto every line
 * through AsyncLocalStorage, and `Logger.onError` forwards the error to Sentry. Neither carries a
 * tenant: no route calls `trace({ environmentId }, ...)`, and the builders' own boundary log is
 * `logBoundaryError(message, error, url)`, a url and an error. So an incident tells you which route
 * and which request failed, and never whose environment it was, unless the route passed the field
 * itself. 21 of 427 entry points do.
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
    const failurePathLogs = ep.logCalls.filter((l) => l.inCatch);
    const named = failurePathLogs.find((l) => l.fields.some((f) => IDENTIFIER_FIELD.test(f)));
    if (named) {
      const fields = named.fields.filter((f) => IDENTIFIER_FIELD.test(f));
      return { id: ID, status: "pass", detail: `failure log names ${fields.join(", ")}` };
    }
    if (failurePathLogs.length > 0) {
      return {
        id: ID,
        status: "fail",
        detail:
          "logs its failure without naming an environment, project, organization, run or user",
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
