# @internal/observability-map

Scores every webapp entry point on whether it could explain itself during an incident, and prints
the ones worth fixing. An entry point is a Remix `loader` or `action` under
`apps/webapp/app/routes`, 427 of them today.

The score is 19 out of 100. It is low because the webapp does not attach tenant identity to its
failures: **11 of the 412 measured entry points name an environment, project, organization or user
on a failure path.** Everything else, when it breaks at 3am, gives you the route and the request id
and nothing about whose request it was.

Every figure here comes from a run against the tree as it stands. How the scanner reaches a verdict,
and what it refuses to decide, is in [INTERNALS.md](./INTERNALS.md).

## Running it

```bash
pnpm --filter @internal/observability-map run map            # the whole tree
pnpm --filter @internal/observability-map run map --json     # same, as JSON on stdout
pnpm --filter @internal/observability-map run map /api/v1/token   # one route, with its check results
```

The whole-tree run also writes `observability-map.json` at the repo root, which `--no-write`
suppresses. Single-route mode takes either the route path the report prints (`/api/v1/token`) or the
file name (`api.v1.token.ts`). An exact match wins over the routes it is a prefix of, and an
ambiguous prefix warns and names the alternatives rather than picking one.

## CI

A pull request touching `apps/webapp/app/routes` or this package gets a sticky comment scanning head
against the tip of the base branch, with the score, what changed, and the current fix list. Every
comment names the head commit it was rendered for, as a link to the compare range, because the
comment is edited in place across pushes and otherwise says nothing about which push it reflects. It
is report-only: nothing in the comment or its score fails the build or blocks a merge. Separately,
this package's test suite runs as a required check, on pull requests touching `apps/webapp/app` and
on any other package through the internal job, and fails when a symbol the tool references stops
resolving in one of the three trees it reads (`apps/webapp/app`, `packages/plugins/src`,
`internal-packages/rbac/src`), or when the first route with an anticipated sensitive segment lands.
Each failure names the list to update (`src/webappSymbols.test.ts`).
See `.github/workflows/observability-map.yml`.

The workflow runs on every pull request and applies the path list as a gate inside the job rather
than as a `paths:` filter on the trigger. GitHub evaluates one of those per workflow, so a pull
request whose diff stops matching never starts the workflow at all, and the comment an earlier push
left then stands for ever showing findings that are no longer in the diff. The case that matters is
a pull request touching a route and other files whose author reverts the route change and keeps the
rest, which still has a diff and still does not match. So a pull request with a comment and nothing
left to compare gets the comment reconciled to its resolved state without scanning anything, and one
with neither pays for a single cheap job that reads the paths and looks for a comment.

The base is `github.event.pull_request.base.sha` rather than a merge base, which reviewers have
reported as a bug twice. `actions/checkout` on a `pull_request` event checks out GitHub's test merge
commit, whose two parents are `base.sha` and the PR head, so the head tree being scanned already
contains everything on the base branch up to `base.sha`. Diffing that against `base.sha` isolates
the pull request's own work. A real merge base would leave the intervening base-branch commits in
the head tree and out of the base tree, and attribute all of them to the pull request.

## What the score means

It is the mean score of the 412 entry points that had at least one applicable check, where an
entry's score is the share of its applicable checks that passed.

One property of that definition will mislead you otherwise. **Changing which routes a check applies
to moves the score without anything in the webapp changing.** Widening the sensitive cohort from 26
routes to 67 gave `auth-boundary` 39 more routes to look at, 36 of which already passed it, and the
global went from 15 to 19 without a line of `apps/webapp` changing. Narrowing a check, or a refactor
that takes routes out of the denominator, runs the same way in reverse. A movement is evidence about
the codebase only once you have checked the CHECKS block below for an applicability change. Compare
fix lists, not scores.

The number is deliberately unflattering, and one platform change would move most of it. Nothing
central attaches a tenant: `logger` pushes `{ requestId, path, host, method }` onto every line
through AsyncLocalStorage and forwards errors to Sentry, and the route builders log
`logBoundaryError(message, error, url)`. If the auth path pushed `environmentId` through
`trace(...)`, several hundred entry points would flip at once, and `request-context` would want
rethinking rather than celebrating.

### What the number cannot tell you

`request-context` checks that a failure-path log names a tenant field. It does not check that the
value is real. Adding a synthetic `environmentId: "obs-map"` field to the first object argument of
all 139 in-catch log calls, with no other change, takes the global from 19 to 29 and the CONTEXT
figure from 11 to 98.

That is the tool verifying presence, not meaning, and it is not a bug to fix. Every check reads
syntax: a field name, a call, a binding reference. None can tell a genuine tenant id from a
hardcoded string with the right key. A reviewer owns whether the value behind the field is real, the
same way a Lighthouse accessibility score checks that an `alt` attribute exists and not that its
text describes the image. The number tells you where to look. It does not tell you what you will
find there.

### What stops it being gamed

`src/mutationCorpus.test.ts` applies 53 semantics-preserving or handling-deleting rewrites to the
whole route tree in a temp copy and asserts three things for each: the published global does not
rise, the mean over the routes measured in both runs does not rise, and for a semantics-preserving
rewrite no individual route's score rises or drops out of the measured set. Every laundering shape a
reviewer has found is an entry in `src/mutations.ts`, and each entry says which kind it is.

Two entries are the ones the design turns on. Deleting every catch clause in the tree drops the
score from 19 to 8, so the metric does not pay you for removing error handling. Wrapping every body
in `try { ... } catch (e) { throw e }` leaves the global at 19 and raises no route, so it does not
pay you for adding error handling that does nothing either.

Two holes are open and the corpus says so. A catch over `try { 0; }` is refused, but `canRaise`
accepts any call, so `try { String(0); }` reads as real error handling: it takes the tree from 19 to
44 and raises 224 routes. Telling an inert call from one that can throw needs types the scanner does
not have. The second, `dead-conjunction-instanceof-if`, is a dead condition rather than a dead arm:
`selectsADistinctPath` folds the arm, and `literalTruth` treats `&&` as always null on purpose so a
live guard is never read as dead, so widening that fold is a different rule needing its own
measurement. Both run as expected failures with the residual written out beside them, so the claim
is "51 rewrites are defended and here are the two that are not", never "unpaddable".

The corpus takes minutes rather than seconds, under two on CI's runner and closer to eight on a
laptop, so it is gated behind `OBS_MAP_MUTATION_CORPUS=1`
and runs as its own CI job rather than in `pnpm test`. Run it if you change this package:

```bash
OBS_MAP_MUTATION_CORPUS=1 pnpm --filter @internal/observability-map exec vitest run \
  src/mutationCorpus.test.ts --disable-console-intercept
```

## The five checks

- **error-classification**: does every catch clause decide what it caught, by branching on the error
  or by guarding a parse it can answer for. A clause that only rethrows decides nothing and is read
  as though there were no catch, so it neither passes nor fails.
- **auth-boundary**: does a route handling credentials, access control, sessions, billing or
  impersonation check who is asking.
- **auth-scope**: does a sensitive builder-wrapped route also narrow itself to the caller, in every
  export, by declaring `authorization` or by filtering on the caller's own id. All nine route
  builders authenticate the request, but their `authorization` option is optional and
  `apiBuilder.server.ts` runs the RBAC gate inside `if (authorization)`, so a route can be
  authenticated and scoped to nobody. That is the cross-org IDOR class `apps/webapp/CLAUDE.md`
  names. It applies to 19 routes and 17 pass; both failures resolve their target organization from
  the URL slug with no membership filter and put nothing but an ability check in front of it
  (`_app.orgs.$organizationSlug.settings.sso/route.tsx` in its loader,
  `_app.orgs.$organizationSlug.settings.team/route.tsx` in its action). The fix in each is
  `members: { some: { userId } }` on the lookup.
- **request-context**: when this entry point's failure is reported, is the tenant named.
- **audit-trail**: does a sensitive mutation leave a record of who did it. Three routes do, all of
  them impersonation paths reaching `prisma.impersonationAuditLog.create` in
  `models/admin.server.ts`; the other 46 do not.

`audit-trail` is excluded from the score. The other four are in it.

`auth-boundary`, `auth-scope` and `audit-trail` only look at routes `src/sensitivity.ts` calls
sensitive, and that cohort is the fix list's primary sort key, so what goes in it decides what a
reader sees first. 67 routes are in it today: credentials and tokens, envvars, billing and the two
billing settings the bare `billing` segment does not match, impersonation, membership and invites
and roles and the team page, the login surface, API keys, and org or project deletion. Calling a
guard never makes a route sensitive, and `src/webappSymbols.test.ts` fails if a symbol or path
segment in the vocabulary stops resolving in the webapp.

## What the score is made of

The check list describes a composite the number mostly is not, so the report discloses the shape
instead of hiding it behind a weight. Today:

```text
CHECKS
  error-classification  166 applicable,  94 pass,   0 sole, global without it 10
  auth-boundary          62 applicable,  59 pass,   0 sole, global without it 15
  auth-scope             19 applicable,  17 pass,   0 sole, global without it 18
  request-context       412 applicable,  11 pass, 223 sole, global without it 65
  audit-trail            49 applicable,   3 pass,   0 sole, not in the score
```

`sole` says the most: 223 of the 412 measured entry points have exactly one applicable scored check,
so their score is 0 or 100 on a single boolean. Read the family bars with that in mind. They do not
compare families on observability in general; they mostly compare them on whether someone wrote a
tenant field into a catch log.

Weighting was considered and rejected, because a coefficient nobody can explain invites argument
about the number instead of about the finding. The block above is in the terminal report and in the
JSON as `checkContributions`.

## Two findings are headlines, not list entries

`audit-trail` fails 46 of 49 and `request-context` fails 401 of 412. Printing either one per route
would bury the route-specific findings under the same sentence repeated hundreds of times, so both
are reported as a figure: the `AUDIT` and `CONTEXT` lines. 328 entry points fail nothing except
`request-context` and appear only in that figure, which leaves 76 in the fix list. An entry that
fails `request-context` *and* another scored check keeps both findings and stays in the list, so
`/account/tokens` still shows the whole picture. `audit-trail` does not count as "another" for this
purpose, being already a headline, so a route failing only `request-context` and `audit-trail`
collapses too (28 do today, all of them sensitive).

42 of those 328 are sensitive, so the `CONTEXT` line says how many. Read them out of
`observability-map.json`, where every entry keeps its full check results, rather than assuming the
fix list is the whole story.

`request-context` is still scored, unlike `audit-trail`. The gap it measures is real and the score
is meant to show it. Only the presentation collapses.

## When a check declines to judge

The rule every applicability decision follows: **would this evidence necessarily be visible in the
body if it existed?**

A log call inside a catch would be, because the catch is right there in the body being read, so its
absence is evidence of absence and `request-context` fails the route. A guard on work that happens
inside an imported helper would not be, because neither the work nor the guard is in the body, so
`auth-boundary` reports not-applicable with a detail saying it could not verify rather than accusing
the route of being unguarded. `resources.impersonation.ts` is the worked example: it calls
`clearImpersonation`, which authenticates and writes an audit row in `app/models/admin.server.ts`, a
file this tool never opens. Five of the 67 sensitive routes sit out for this reason.

The failure mode the rule exists to prevent is a fix list whose top three entries are all wrong,
which is what a check asserting more than its evidence supports produces.

## Not applicable is not a pass

An entry with no applicable scored check is `measured: false`, and it is left out of every mean the
report computes (`src/score.test.ts`: `excludes an unmeasured entry point from the global mean`,
`excludes an unmeasured entry point from its family mean too`). Its `score` field reads 100, a
placeholder for "nothing was measured here" that nothing averages, because the alternative of
letting unmeasured entries into the mean at 100 would let the tool look better the less it
understood. The header prints every count (`412 measured, 15 unmeasured`) so the denominator is
never hidden, and a family with nothing measured renders as `not measured` rather than as a full
green bar.

15 of the 427 routes are unmeasured because `isTrivial` rules them out before any check runs.
Trivial means a body of three statements or fewer, three or fewer calls, no try/catch, no builder
wrapping it, and nothing in the calls or the source naming a datastore or a service (`prisma`,
`logger`, `fetch`, `redis`, and the like). Parse the params, build a path, redirect: nothing there
for a check to find evidence in either way. Exclusion is a denominator exit, not a credit.

A route whose body is somewhere else is a different case. `export { action } from "./handler.server"`
and `export const action = handleWebhook` are not trivial: a redirect stub genuinely has nothing to
instrument, while a delegating route has work the scanner cannot see, and treating them alike would
delete a route from the metric whenever someone moved a body into a `.server.ts` file. Delegating
routes are counted apart from the unmeasured ones, listed on a `DELEGATED` line and carried in the
JSON as `delegating`, the same treatment a parse failure gets and for the same reason. There are
none in the tree today, which is exactly why the case needed writing down before someone wrote one.

## Suppression

```ts
// obs-map-disable auth-boundary -- public by design, see ADR 12
```

The reason is mandatory: a suppression without one is ignored. The directive is read from comments
only, so a string literal quoting it does not switch a check off.

It applies to the whole entry point, not to the line under it. Line scoping is not available,
because a finding is attached to an entry point and carries no line number to match against, which
is why the old `obs-map-disable-next-line` spelling is not honoured.

A suppression cannot raise a score. The suppressed check leaves the numerator and the denominator,
and the result is capped by what the entry would have scored unsuppressed, so suppressing a failing
check holds the number still rather than improving it (`src/score.test.ts`: `does not raise the
score when a failing check is suppressed`). What you buy is removal from the worklist with a reason
on the record. The report prints how many suppressions are in force so the practice stays visible.

## Known limits

Read these before trusting a specific verdict.

- **One hop, same file only.** If a loader delegates to a helper in the same file, that helper's
  statements, catches and calls count as the route's. A helper's own helpers do not, and nothing
  imported from another module is ever opened. `auth-boundary` applies to 62 of the 67 sensitive
  entry points; the other 5 hand their work to an imported helper and are reported as unverified
  rather than unguarded.
- **A guard is matched by name, not by what it does.** The accept-list is 29 names read off the
  webapp, plus two `SOFT_GUARDS`. `src/webappSymbols.test.ts` proves each one is declared somewhere;
  nothing proves the declaration it found is the guard we meant. `authenticateAdmin` and
  `authenticatePlainRequest` are local helpers inside one route file each, so a second route
  declaring its own no-op function of either name would be credited.
- **Two guard names are only checked as far as being read.** `getUser` and `getUserId` answer with
  null instead of throwing, so calling one is not a boundary. They are credited only when the body
  binds the result and some condition reads it (`EntryPoint.checkedCallees`). What that cannot see
  is whether the test guards anything: `if (!user) { logger.warn("anonymous"); }` followed by the
  work reads the same as returning.
- **`authenticate` and `isAuthenticated` are unresolved on purpose.** They are remix-auth's, and
  resolving them means reading a path inside `apps/webapp/node_modules`, which fails confusingly on
  an install-layout change. They are listed in `EXTERNAL_GUARDS` instead, so the resolution test
  still rejects a name that is neither first-party nor listed.
- **`auth-scope` applicable structurally implies `auth-boundary` pass.** The check only applies to a
  builder-wrapped route, and `auth-boundary` passes any builder-wrapped route, so all 19 carry the
  same `auth-boundary` detail, "authenticated by the builder". That free point is a third or a
  quarter of each of their scores: the 19 average 59.7 as scored and 44.6 with `auth-boundary` taken
  out, and `settings.team`, a confirmed cross-org exposure, scores 25 rather than 0. Read the
  finding rather than the score.
- **`auth-scope` cannot tell a caller-id filter from a caller-id actor argument.**
  `presenter.call({ userId: user.id })` narrows the query; `generatePortalLink({ organizationId,
  userId: user.id })` records who asked. Both read as scoping. Separating them means following the
  argument into the callee, so the four helpers credited this way (`ApiKeysPresenter`,
  `TeamPresenter`, `regenerateApiKey`, `DeleteOrganizationService`, all of which do
  `members: { some: { userId } }` and throw) were hand-read instead. No route in the tree passes on
  an actor argument alone.
- **`auth-scope` reads property assignments in that export's own handler.** A handler that pulls the
  id into a local first, `const userId = user.id; ... { userId }`, or that builds its filter in a
  same-file helper, scopes itself and is not seen, so it would be reported as unscoped.
- **`auth-scope` reads the builder-wrapped exports and says nothing about the rest of the file.** A
  route whose action is builder-wrapped and whose loader is a plain `export async function loader`
  is judged on the action alone, and the pass detail, "every builder-wrapped export has an
  authorization gate", is true of what it read while reading as a claim about the whole route. Ten
  routes in the tree mix the two, and the one sensitive enough for the check to run on is
  `_app.orgs.$organizationSlug.settings._index/route.tsx`, whose builder-wrapped action carries the
  pass and whose plain loader filters on `members: { some: { userId } }`. That was hand-read.
- **Three login-flow routes fail `auth-boundary` correctly and unhelpfully.** `/auth/sso`,
  `/api/v1/authorization-code` and `/api/v1/token` are unauthenticated by design: the caller is
  anonymous at that point, which is the whole purpose. The check's statement about them is true and
  there is nothing to fix, so they are candidates for a suppression comment with the reason on the
  record.
- **Loggers are matched by spelling.** A call counts as logging when the callee reads `logger.*` or
  `log.*`. An aliased logger, one wrapped in a helper, or `console.error` is invisible, so a route
  can be reported as recording nothing while it records plenty.
- **A catch that logs and rethrows reads as though it only rethrows.** The clause evidence cannot say
  whether a clause does anything besides rethrow, so `error-classification` withholds credit rather
  than granting it and reopening the free-points path a single `logger.error` line wide.
- **Only the first object-literal argument is read** for identifier fields, and only its property
  names. `logger.error("failed", ctx)` where `ctx` is a variable contributes nothing, and neither
  does a second object.
- **A catch inside a per-item callback is not the route's.** `items.map((item) => { try {...} })` is
  a fresh boundary per element, so its clause is not read as the route's own error handling. The
  test is the method name, which cannot tell `users.map` from `Result.map`. Being wrong there costs
  precision rather than points: a refused catch fails the route rather than excusing it.
- **A route that delegates only one of its two exports is judged on the other.**
  `export { action } from "./x"` beside a loader written in the file is not counted as delegating,
  so half the route is scored and half is invisible.
- **`try { String(0); }` still buys a pass.** The open corpus entry above, and the largest single
  hole known in the tool: measured live, it takes the tree from 19 to 44 and raises 224 routes.
- **A forged tenant field buys a pass too.** `request-context` reads the field name, never the
  value, so a codemod writing `environmentId: "obs-map"` into every in-catch log call takes the
  global from 19 to 29. Unlike the entry above this one is not a bug to fix, since no syntactic
  check can tell a real tenant id from a constant, but it bounds what the number can mean either
  way.
- **The score is a mean of means over a heuristic.** Read the fix list, the two headline figures and
  the CHECKS block. Watching the single number for small movements will mislead you.

## Layout

`scan.ts` walks the routes directory and produces an `EntryPoint` per module, carrying only
body-scoped evidence. `checks/` holds the five checks, each a pure function of an `EntryPoint`.
`score.ts` turns checks into an entry score and a report, `report/` renders it, `cli.ts` is the
entry point. `sensitivity.ts`, `triviality.ts` and `suppression.ts` are the three inputs the checks
share.

Tests sit next to their subject in `src/`. Every check has a false-positive fixture, something it
must not flag, alongside the positive one. Keep that: most of the bugs this package has had were
checks that fired on the wrong thing, and a test that only proves the heuristic fires would have
caught none of them.
