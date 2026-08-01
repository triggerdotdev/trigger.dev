# @internal/observability-map

Scores every webapp entry point on whether it could explain itself during an incident, and prints
the ones worth fixing. An entry point is a Remix `loader` or `action` under
`apps/webapp/app/routes`, 427 of them at the time of writing.

The number it prints today is 17 out of 100. That is not a bug, and the rest of this file is mostly
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

## CI

A PR that touches `apps/webapp/app/routes` or this package gets a sticky comment scanning head
against the PR's merge base, with the score, what changed, and the current fix list. It is
report-only: nothing here fails the build or blocks a merge, and the gate stays deferred until a
later phase decides to add one. See `.github/workflows/observability-map.yml`.

## What 17 means

It is the mean score of the 412 entry points that had at least one applicable check, where an
entry's score is the share of its applicable checks that passed. It is low because the webapp does
not attach tenant identity to its failures: **21 of 412 entry points name an environment, project,
organization, run or user on a failure path.** Everything else, when it breaks at 3am, tells you the
route and the request id and nothing about whose request it was.

The score was 76 until we stopped crediting routes for the error handling they do not do. Emptying
every catch clause in the tree used to score it 100, which meant the metric paid you for deleting
error handling.

Two invariants hold now, and both are asserted in `test/score.test.ts` rather than measured once:

- **Removing error handling must not raise the score.** Deleting every catch clause drops it to 8,
  and deleting the logs as well drops it to 2.
- **Adding error handling that does nothing must not raise the score.** Wrapping every body in
  `try { ... } catch (e) { throw e }` leaves the score unchanged. That mutation used to be worth 27
  points across the tree, because a rethrow-only clause counted as a pass while no catch at all was
  not-applicable, and the two are observationally identical.

If you change this package, check both directions still hold.

So the number is deliberately unflattering, and one platform change would move most of it. Nothing
central attaches a tenant: `logger` pushes `{ requestId, path, host, method }` onto every line
through AsyncLocalStorage and forwards errors to Sentry, and the route builders log
`logBoundaryError(message, error, url)`. If the auth path ever pushed `environmentId` through
`trace(...)`, several hundred entry points would flip at once, and this check would want rethinking
rather than celebrating.

## The four checks

- **error-classification**: does every catch clause decide what it caught, by branching on the
  error or by guarding a parse it can answer for. A clause that only rethrows decides nothing and
  is read as though there were no catch, so it neither passes nor fails.
- **auth-boundary**: does a route handling credentials, tokens, billing or impersonation check who
  is asking.
- **request-context**: when this entry point's failure is reported, is the tenant named.
- **audit-trail**: does a sensitive mutation leave a record of who did it. Nothing in the webapp
  writes one, so every applicable entry point fails.

`audit-trail` is excluded from the score. `request-context` is in it.

## Two findings are headlines, not list entries

`audit-trail` fails 19 of 19, and `request-context` fails 391 of 412. Printing either one per route
would bury the route-specific findings under the same sentence repeated hundreds of times, so both
are reported as a figure: the `AUDIT` and `CONTEXT` lines. 329 entry points fail nothing except
`request-context` and appear only in that figure, which leaves 71 in the fix list. An entry that
fails `request-context` *and* another scored check keeps both findings and stays in the list, so
`/account/tokens` still shows the whole picture. `audit-trail` does not count as "another" for this
purpose: it is already a headline, so a route failing only `request-context` and `audit-trail`
collapses too (13 do today, all sensitive, which is most of the 18 below).

18 of those 329 are sensitive, including `/admin/impersonate`, the API-key regeneration route and
four envvars routes, so the `CONTEXT` line says how many. Read them out of
`observability-map.json`, where every entry keeps its full check results, rather than assuming the
list is the whole story.

`request-context` is still scored, unlike `audit-trail`. The gap it measures is real and the score
is meant to show it. Only the presentation collapses.

## Not applicable is not a pass

An entry with no applicable scored check is `measured: false`, and it is left out of every mean the
report computes. Its `score` field reads 100, which is a placeholder for "nothing was measured
here", not a verdict, and nothing averages it. This matters because the alternative, letting
unmeasured entries into the mean at 100, would let the tool look better the less it understood. The
header prints both counts (`412 measured, 15 unmeasured`) so the denominator is never hidden, and a
family with nothing measured renders as `not measured` rather than as a full green bar.

15 of those 427 routes are unmeasured because `isTrivial` (`src/triviality.ts`) rules them out before
any check runs. Trivial means a body of three statements or fewer, three or fewer calls, no
try/catch, no builder wrapping it, and nothing in the calls or the source naming a datastore or a
service (`prisma`, `logger`, `fetch`, `redis`, and the like). Parse the params, build a path,
redirect: nothing there for a check to find evidence in either way. Exclusion is a denominator exit,
not a credit: a trivial route's `score` is the same placeholder 100 that an unmeasured entry always
carries, and it is left out of every mean for the same reason. Scoring it a pass instead would say a
route earned a clean result by never doing anything a check could look at, which is the same vacuous
100 the header already refuses to average in.

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
// obs-map-disable auth-boundary -- public by design, see ADR 12
```

The reason is mandatory: a suppression without one is ignored. The directive is read from comments
only, so a string literal quoting it does not switch a check off.

It applies to the whole entry point, not to the line under it. It was called
`obs-map-disable-next-line`, which was untrue in a way that mattered: a directive on the last line
of a file switched a check off for everything above it. Genuine line scoping is not available,
because a finding is attached to an entry point and carries no line number to match against, so the
name was corrected instead. The old spelling is not honoured, and there is a test saying so.

A suppression cannot raise a score. The suppressed check leaves the numerator and the denominator,
and the result is capped by what the entry would have scored unsuppressed, so suppressing a failing
check holds the number still rather than improving it. What you buy is removal from the worklist
with a reason on the record. The report prints how many suppressions are in force so the practice
stays visible.

## The gaming boundary

`request-context` checks that a failure-path log names a tenant field. It does not check that the
value is real. A codemod that added `environmentId` to every in-catch `logger.error` call, wiring it
up to the wrong variable or a constant, would move the score exactly as far as one that wired it up
correctly. Measured on the real tree: adding a synthetic `environmentId` field to every in-catch log
call, with no other change, takes the global score from 17 to 27.

That is the tool verifying presence, not meaning, and it is not a bug to fix. Every check here reads
syntax: a field name, a call, a binding reference. None of them can tell a genuine tenant id from a
hardcoded string with the right key. What a reviewer owns is whether the value behind the field is
real, the same way a Lighthouse accessibility score checks that an `alt` attribute exists and not
that its text describes the image. The number tells you where to look. It does not tell you what
you will find there.

## Known limits

Read these before trusting a specific verdict.

- **One hop, same file only.** If a loader delegates to a helper in the same file, that helper's
  statements, catches and calls count as the route's. A helper's own helpers do not, and nothing
  imported from another module is ever opened. `auth-boundary` applies to 23 entry points: it gates
  on sensitivity first, which is 26 routes, and the one-hop limit accounts for the other 3, which
  hand their work to an imported helper and are reported as unverified rather than unguarded.
- **Loggers are matched by spelling.** A call counts as logging when the callee reads `logger.*` or
  `log.*`. An aliased logger, one wrapped in a helper, or `console.error` is invisible, so a route
  can be reported as recording nothing while it records plenty.
- **A catch that logs and rethrows reads as though it only rethrows.** The clause evidence cannot
  say whether a clause does anything besides rethrow, so `error-classification` withholds credit
  rather than granting it. Crediting it would reopen the free-points path a single `logger.error`
  line wide.
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
