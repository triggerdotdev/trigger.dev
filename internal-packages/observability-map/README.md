# @internal/observability-map

Scores every webapp entry point on whether it could explain itself during an incident, and prints
the ones worth fixing. An entry point is a Remix `loader` or `action` under
`apps/webapp/app/routes`, 427 of them at the time of writing.

The number it prints today is 19 out of 100. That is not a bug, and the rest of this file is mostly
about why you should believe it.

## Running it

```bash
pnpm --filter @internal/observability-map run map            # the whole tree
pnpm --filter @internal/observability-map run map --json     # same, as JSON on stdout
pnpm --filter @internal/observability-map run map /api/v1/token   # one route, with its check results
```

The whole-tree run also writes `observability-map.json` at the repo root, which `--no-write`
suppresses. The single-route mode takes either the route path the report prints (`/api/v1/token`) or
the file name (`api.v1.token.ts`). An exact match wins over the routes it is a prefix of, and an
ambiguous prefix warns and names the alternatives rather than silently picking one.

## What 19 means

It is the mean score of the 412 entry points that had at least one applicable check, where an
entry's score is the share of its applicable checks that passed. It is low because the webapp does
not attach tenant identity to its failures: **21 of 412 entry points name an environment, project,
organization, run or user on a failure path.** Everything else, when it breaks at 3am, tells you the
route and the request id and nothing about whose request it was.

The score was 76 until we stopped crediting routes for the error handling they do not do. Emptying
every catch clause in the tree used to score it 100, which meant the metric paid you for deleting
error handling. Now removing the catches takes 19 down to 8, and removing the logs as well takes it
to 2. If you change this package, keep that property: mutate the tree to remove error handling and
check the score falls.

So the number is deliberately unflattering, and one platform change would move most of it. Nothing
central attaches a tenant: `logger` pushes `{ requestId, path, host, method }` onto every line
through AsyncLocalStorage and forwards errors to Sentry, and the route builders log
`logBoundaryError(message, error, url)`. If the auth path ever pushed `environmentId` through
`trace(...)`, several hundred entry points would flip at once, and this check would want rethinking
rather than celebrating.

## The four checks

- **error-classification**: does every catch clause decide what it caught, by rethrowing, by
  branching on the error, or by guarding a parse it can answer for.
- **auth-boundary**: does a route handling credentials, tokens, billing or impersonation check who
  is asking.
- **request-context**: when this entry point's failure is reported, is the tenant named.
- **audit-trail**: does a sensitive mutation leave a record of who did it. Nothing in the webapp
  writes one, so every applicable entry point fails.

`audit-trail` is excluded from the score. `request-context` is in it.

## Two findings are headlines, not list entries

`audit-trail` fails 19 of 19, and `request-context` fails 391 of 412. Printing either one per route
would bury the route-specific findings under the same sentence repeated hundreds of times, so both
are reported as a figure: the `AUDIT` and `CONTEXT` lines. 333 entry points fail nothing except
`request-context` and appear only in that figure, which leaves 67 in the fix list. An entry that
fails `request-context` *and* something else keeps both findings and stays in the list, so
`/account/tokens` still shows the whole picture.

`request-context` is still scored, unlike `audit-trail`. The gap it measures is real and the score
is meant to show it. Only the presentation collapses.

## Not applicable is not a pass

An entry with no applicable scored check is `measured: false`, and it is left out of every mean the
report computes. Its `score` field reads 100, which is a placeholder for "nothing was measured
here", not a verdict, and nothing averages it. This matters because the alternative, letting
unmeasured entries into the mean at 100, would let the tool look better the less it understood. The
header prints both counts (`412 measured, 15 unmeasured`) so the denominator is never hidden, and a
family with nothing measured renders as `not measured` rather than as a full green bar.

## When a check declines to judge

The rule every applicability decision follows: **would this evidence necessarily be visible in the
body if it existed?**

A log call inside a catch would be, because the catch is right there in the body being read. So its
absence is evidence of absence and `request-context` fails the route. A guard on work that happens
inside an imported helper would not be, because neither the work nor the guard is in the body. So
`auth-boundary` reports not-applicable with a detail saying it could not verify, rather than
accusing the route of being unguarded. `resources.impersonation.ts` is the worked example: it calls
`clearImpersonation`, which authenticates and writes an audit row in `app/models/admin.server.ts`,
a file this tool never opens.

The failure mode this rule exists to prevent is a fix list whose top three entries are all wrong.
That happened, twice, and both times the cause was a check asserting something the evidence did not
support.

## Suppression

```ts
// obs-map-disable-next-line auth-boundary -- public by design, see ADR 12
```

The reason is mandatory: a suppression without one is ignored. The directive is read from comments
only, line by line, so a string literal quoting it does not switch a check off.

A suppression cannot raise a score. The suppressed check leaves the numerator and the denominator,
and the result is capped by what the entry would have scored unsuppressed, so suppressing a failing
check holds the number still rather than improving it. What you buy is removal from the worklist
with a reason on the record. The report prints how many suppressions are in force so the practice
stays visible.

## Known limits

Read these before trusting a specific verdict.

- **One hop, same file only.** If a loader delegates to a helper in the same file, that helper's
  statements, catches and calls count as the route's. A helper's own helpers do not, and nothing
  imported from another module is ever opened. Most of what a route does is behind an import, which
  is why `auth-boundary` applies to 26 entry points rather than 427.
- **Loggers are matched by spelling.** A call counts as logging when the callee reads `logger.*` or
  `log.*`. An aliased logger, one wrapped in a helper, or `console.error` is invisible, so a route
  can be reported as recording nothing while it records plenty.
- **Only the first object-literal argument is read** for identifier fields, and only its property
  names. `logger.error("failed", ctx)` where `ctx` is a variable contributes nothing, and neither
  does a second object.
- **Inline callbacks are not descended into** when counting statements, so a two-statement body can
  hold a pile of work inside a `.map()`. The call count is what catches those cases, imperfectly.
- **Sensitivity is a heuristic**: a symbol list plus path segments. It was circular until recently,
  counting `requireAdminApiRequest` as a hazard when it is a mitigation, which made 34 of 67
  sensitive routes sensitive purely for being guarded. Expect it to need pruning again as routes
  move.
- **The score is a mean of means over a heuristic.** Read the fix list and the two headline figures.
  Watching the single number for small movements will mislead you.

## Layout

`scan.ts` walks the routes directory and produces an `EntryPoint` per module, carrying only
body-scoped evidence. `checks/` holds the four checks, each a pure function of an `EntryPoint`.
`score.ts` turns checks into an entry score and a report, `report/` renders it, `cli.ts` is the
entry point. `sensitivity.ts`, `triviality.ts` and `suppression.ts` are the three inputs the checks
share.

Tests sit next to their subject in `test/`. Every check has a false-positive fixture, something it
must not flag, alongside the positive one. Keep that: most of the bugs this package has had were
checks that fired on the wrong thing, and a test that only proves the heuristic fires would have
caught none of them.
