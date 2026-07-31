import type { CheckResult, EntryPoint, LogCall } from "../types.js";
import { isTrivial } from "../triviality.js";
import { isParseGuard } from "./errorClassification.js";

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
 * Applicability turns on whether the route keeps its own failures, never on whether it logs. The
 * first version made a route not-applicable when it had no failure-path log, which excused the very
 * thing the check exists to find and meant deleting a log line took a route out of the report.
 * Every non-trivial entry point is now judged:
 *
 * - no catch at all, or nothing but parse guards: pass. The route's own work still throws past it
 *   to the central handler, which is the intended path in this codebase, and the tenant that
 *   handler does not name is a platform-level gap reported once rather than against each route. A
 *   `try { body = await request.json() } catch { 400 }` is not a route taking over its failure
 *   path, and reading it as one put false positives at the top of the first rendered report.
 * - a catch that covers the route's work: it decided the outcome itself, so it has to say whose
 *   failure it was.
 *
 * Deleting a log call can then only make a verdict worse or leave it alone, and adding a catch
 * without a report is a regression the check reports, which is the direction the incentive should
 * run in. The one move that still improves a verdict is deleting the try/catch outright, and that
 * hands the error back to the central handler, which `error-classification` also treats as correct.
 */
export const requestContext = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    if (isTrivial(ep)) {
      return { id: ID, status: "not-applicable", detail: "trivial route" };
    }
    // `catches`, not `hasTryCatch`: a try/finally catches nothing, so its errors reach the central
    // handler like any other. A route whose every clause guards a parse is in the same position,
    // its own work still throws past those guards. Same reading error-classification gives them.
    if (ep.catches.every((c) => isParseGuard(c, ep))) {
      return { id: ID, status: "pass", detail: "hands its failures to the central handler" };
    }
    const logs = failurePathLogs(ep);
    const named = logs.find((l) => l.fields.some((f) => IDENTIFIER_FIELD.test(f)));
    if (named) {
      const fields = named.fields.filter((f) => IDENTIFIER_FIELD.test(f));
      return { id: ID, status: "pass", detail: `failure log names ${fields.join(", ")}` };
    }
    return {
      id: ID,
      status: "fail",
      detail:
        logs.length === 0
          ? "keeps its failures and records nothing about whose they were"
          : "logs its failure without naming an environment, project, organization, run or user",
    };
  },
};
