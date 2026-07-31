import type { CheckResult, EntryPoint, LogCall } from "../types.js";

const ID = "request-context";

/**
 * A field name that says which tenant, request or resource the failure belongs to. Matched on the
 * suffix, in the camelCase the webapp writes: `environmentId`, `organizationSlug`, `runFriendlyId`,
 * `projectParam`, `taskIdentifier`. Lowercase `id` inside a word is not a suffix, so `valid` and
 * `paid` do not qualify.
 */
const IDENTIFIER_FIELD = /^(id|ids|slug|ref)$|[a-z](Id|Ids|Slug|Ref|Param|Identifier)$/;

function failurePathLogs(ep: EntryPoint): LogCall[] {
  return ep.logCalls.filter((l) => l.inCatch);
}

/**
 * Whether a failure this route reports itself can be traced to whoever it happened to.
 *
 * Everything the platform attaches centrally is already accounted for, which is what makes this
 * worth asking. `logger` pushes the http context (requestId, path, host, method) onto every line
 * through AsyncLocalStorage, and `Logger.onError` forwards the error to Sentry. Neither carries a
 * tenant: no route calls `trace({ environmentId }, ...)`, and the builders' own boundary log is
 * `logBoundaryError(message, error, url)`, which is a url and an error. So a builder-wrapped route
 * is not attributed either and gets no free pass here. An incident tells you which route and which
 * request; whose environment it was is only ever in the fields the route passes itself.
 *
 * Applicable only where the route reports a failure itself, meaning it logs from inside a catch. A
 * route that rethrows silently has handed the report to Sentry and there is nothing here to
 * inspect. That gate has a perverse edge, noted in the task 5 report: deleting a log line moves a
 * route from fail to not-applicable.
 */
export const requestContext = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    const logs = failurePathLogs(ep);
    if (logs.length === 0) {
      return { id: ID, status: "not-applicable", detail: "reports no failure of its own" };
    }
    const named = logs.find((l) => l.fields.some((f) => IDENTIFIER_FIELD.test(f)));
    if (named) {
      const fields = named.fields.filter((f) => IDENTIFIER_FIELD.test(f));
      return { id: ID, status: "pass", detail: `failure log names ${fields.join(", ")}` };
    }
    return {
      id: ID,
      status: "fail",
      detail: "logs its failure without naming an environment, project, organization, run or user",
    };
  },
};
