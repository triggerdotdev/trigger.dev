import type { CheckResult, EntryPoint } from "../types.js";
import { isTrivial } from "../triviality.js";

const ID = "request-context";

/**
 * A field name that plausibly names a TENANT: environment, organization, project or user. Anchored on
 * the root word and not just the suffix, so `batchId` and `spanParam` do not qualify: those name a
 * resource the failure touched rather than who it happened to. The abbreviated roots require a
 * suffix, because a bare `env` is ambiguous with `{ env: process.env.NODE_ENV }`.
 */
const TENANT_FIELD =
  /^(environment|organization|project|user)(Id|Ids|Slug|Ref|Param|Identifier)?$|^(env|org)(Id|Ids|Slug|Ref|Param|Identifier)$/;

/**
 * Read against the real logger (`packages/core/src/logger.ts`), whose levels are `log`, `error`,
 * `warn`, `info`, `debug`, `verbose`, with no `fatal` and no `trace`. `log` is level 0, which
 * `TRIGGER_LOG_LEVEL` never filters out. `info` is not reserved for failure reporting and
 * `debug`/`verbose` are routinely sampled out before anyone reads an incident, so neither qualifies.
 */
const QUALIFYING_LEVELS = new Set(["log", "error", "warn"]);

/** The level a `LogCall`'s callee was made at, e.g. `"error"` from `logger.error`. */
function logLevel(callee: string): string {
  return callee.slice(callee.lastIndexOf(".") + 1);
}

/**
 * Whether a failure here can be traced to whoever it happened to.
 *
 * Every non-trivial entry point is judged, and a route that never catches fails like any other. That
 * is the whole point rather than an oversight: its failures go to the global handler, which names no
 * tenant. Passing those routes, as this check used to, meant deleting every catch clause in the tree
 * scored it 100, and excusing them as not-applicable is the same mistake in quieter clothes. What the
 * platform attaches centrally and why none of it is a tenant: README, "What the score means".
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
