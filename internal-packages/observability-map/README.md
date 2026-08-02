# @internal/observability-map

Scores every webapp entry point on whether it could explain itself during an incident, and prints
the ones worth fixing. An entry point is a Remix `loader` or `action` under
`apps/webapp/app/routes`, 427 of them at the time of writing.

The number it prints today is 19 out of 100. That is not a bug, and the rest of this file is mostly
about why you should believe it.

Every figure below was re-derived from a run of the tool on the tree as it stands. Every invariant
below names the test that holds it, because on this branch a claim written down without one has
turned out to be false more often than not.

## Running it

```bash
pnpm --filter @internal/observability-map run map            # the whole tree
pnpm --filter @internal/observability-map run map --json     # same, as JSON on stdout
pnpm --filter @internal/observability-map run map /api/v1/token   # one route, with its check results
```

The whole-tree run also writes `observability-map.json` at the repo root, which `--no-write`
suppresses. The single-route mode takes either the route path the report prints (`/api/v1/token`) or
the file name (`api.v1.token.ts`). An exact match wins over the routes it is a prefix of, and an
ambiguous prefix warns and names the alternatives rather than silently picking one
(`src/cli.test.ts`: `prefers an exact match over the routes it is a prefix of`, `warns when a
prefix matches more than one route rather than silently taking the first`).

## CI

A PR that touches `apps/webapp/app/routes` or this package gets a sticky comment scanning head
against the PR's merge base, with the score, what changed, and the current fix list. It is
report-only: nothing here fails the build or blocks a merge, and the gate stays deferred until a
later phase decides to add one. See `.github/workflows/observability-map.yml`.

## What 19 means

It is the mean score of the 412 entry points that had at least one applicable check, where an
entry's score is the share of its applicable checks that passed.

Read that definition carefully before reading the number, because it has a property that will
mislead you otherwise. **Changing which routes a check applies to moves the score without anything
in the webapp changing.** It happened in the round that added this paragraph: widening the sensitive
cohort from 26 routes to 67 gave `auth-boundary` 39 more routes to look at, 36 of which already
passed it, and the global went from 15 to 19. Not one line of `apps/webapp` changed. The same thing
runs in reverse: narrowing a check, or a refactor that takes routes out of the denominator, lowers
or raises it for reasons that are about the tool. So a movement is only evidence about the codebase
once you have checked the CHECKS block below for an applicability change. Compare fix lists, not
scores. It is low because the webapp does
not attach tenant identity to its failures: **11 of 412 entry points name an environment, project,
organization or user on a failure path.** Everything else, when it breaks at 3am, tells you the
route and the request id and nothing about whose request it was.

The score was 76 until we stopped crediting routes for the error handling they do not do. Emptying
every catch clause in the tree used to score it 100, which meant the metric paid you for deleting
error handling.

The property behind that is now a test corpus rather than a claim. `src/mutationCorpus.test.ts`
applies 44 semantics-preserving or handling-deleting rewrites to the whole route tree in a temp copy
and asserts three things for each: the published global does not rise, the mean over the routes
measured in both runs does not rise, and for a semantics-preserving rewrite no individual route's
score rises or drops out of the measured set. Every laundering shape a reviewer has found on this
branch is an entry in it, `src/mutations.ts` holds them, and each entry says which it is.

Two of them are worth naming because they are the ones the design turns on. Deleting every catch
clause in the tree drops the score from 19 to 8, so the metric does not pay you for removing error
handling. Wrapping every body in `try { ... } catch (e) { throw e }` leaves the global at 19 and
raises no route, so it does not pay you for adding error handling that does nothing either.

The rewrites come in two directions and both matter. A subtractive one takes real signal away or
moves it about: delete the catches, wrap the body, merge the statements. An additive one puts fake
signal in: a classifying catch over a try that does nothing, a test whose two arms are the same, a
rethrow that can never run, a call whose name starts with `require`. The corpus had only the
subtractive half for a while, and the two largest holes ever found here were both additive.

One of those is still open and the corpus says so. A catch over `try { 0; }` is refused, but
`canRaise` accepts any call, so `try { String(0); }` reads as real error handling: it takes the tree
from 19 to 44 and raises 224 routes. Telling an inert call from one that can throw needs types the
scanner does not have.

The honest statement is "these 43 rewrites are defended, here they are, and here is the one that is
not", not "unpaddable". One entry, `dead-classifying-try-with-call`, runs as an expected failure
with the residual written out beside it. The corpus takes about four and a half minutes, so it is
gated behind `OBS_MAP_MUTATION_CORPUS=1` and run as its own CI job rather than in `pnpm test`. If
you change this package, run it:

```bash
OBS_MAP_MUTATION_CORPUS=1 pnpm --filter @internal/observability-map exec vitest run \
  src/mutationCorpus.test.ts --disable-console-intercept
```

So the number is deliberately unflattering, and one platform change would move most of it. Nothing
central attaches a tenant: `logger` pushes `{ requestId, path, host, method }` onto every line
through AsyncLocalStorage and forwards errors to Sentry, and the route builders log
`logBoundaryError(message, error, url)`. If the auth path ever pushed `environmentId` through
`trace(...)`, several hundred entry points would flip at once, and this check would want rethinking
rather than celebrating.

## The five checks

- **error-classification**: does every catch clause decide what it caught, by branching on the
  error or by guarding a parse it can answer for. A clause that only rethrows decides nothing and
  is read as though there were no catch, so it neither passes nor fails.
- **auth-boundary**: does a route handling credentials, access control, sessions, billing or
  impersonation check who is asking.
- **auth-scope**: a route builder authenticates the request, and its `authorization` option is
  optional, so a route can be authenticated and scoped to nobody. This asks whether a sensitive
  builder-wrapped route also narrows itself to the caller, in every export, by declaring
  `authorization` or by filtering on the caller's own id.
- **request-context**: when this entry point's failure is reported, is the tenant named.
- **audit-trail**: does a sensitive mutation leave a record of who did it. Three routes do, all of
  them impersonation paths reaching `prisma.impersonationAuditLog.create` in
  `models/admin.server.ts`; the other 46 do not.

`audit-trail` is excluded from the score. The other four are in it.

## What the score is made of

The check list describes a composite the number mostly is not, so the report discloses the
shape instead of hiding it behind a weight. Today:

```text
CHECKS
  error-classification  166 applicable,  94 pass,   0 sole, global without it 10
  auth-boundary          62 applicable,  59 pass,   0 sole, global without it 15
  auth-scope             19 applicable,  17 pass,   0 sole, global without it 18
  request-context       412 applicable,  11 pass, 223 sole, global without it 65
  audit-trail            49 applicable,   3 pass,   0 sole, not in the score
```

`sole` is the figure that says the most: 223 of the 412 measured entry points have exactly one
applicable scored check, so their score is 0 or 100 on a single boolean. Read the family bars with
that in mind. They do not compare families on observability in general; they mostly compare them on
whether someone wrote a tenant field into a catch log.

Weighting was considered and rejected in the design, and that reasoning has not changed: a
coefficient nobody can explain invites argument about the number instead of about the finding. The
block above is in the terminal report and in the JSON as `checkContributions`
(`src/score.test.ts`: `per-check contribution`; `src/report/terminal.test.ts`: `reporting what the score
is made of`).

## Two findings are headlines, not list entries

`audit-trail` fails 46 of 49, and `request-context` fails 401 of 412. Printing either one per route
would bury the route-specific findings under the same sentence repeated hundreds of times, so both
are reported as a figure: the `AUDIT` and `CONTEXT` lines. 328 entry points fail nothing except
`request-context` and appear only in that figure, which leaves 76 in the fix list. An entry that
fails `request-context` *and* another scored check keeps both findings and stays in the list, so
`/account/tokens` still shows the whole picture. `audit-trail` does not count as "another" for this
purpose: it is already a headline, so a route failing only `request-context` and `audit-trail`
collapses too (28 do today, all of them sensitive).

42 of those 328 are sensitive, so the `CONTEXT` line says how many. Read them out of
`observability-map.json`, where every entry keeps its full check results, rather than assuming the
list is the whole story.

`request-context` is still scored, unlike `audit-trail`. The gap it measures is real and the score
is meant to show it. Only the presentation collapses.

## Not applicable is not a pass

An entry with no applicable scored check is `measured: false`, and it is left out of every mean the
report computes (`src/score.test.ts`: `excludes an unmeasured entry point from the global mean`,
`excludes an unmeasured entry point from its family mean too`). Its `score` field reads 100, which
is a placeholder for "nothing was measured here", not a verdict, and nothing averages it. This
matters because the alternative, letting unmeasured entries into the mean at 100, would let the tool
look better the less it understood. The header prints every count (`412 measured, 15 unmeasured`) so
the denominator is never hidden, and a family with nothing measured renders as `not measured` rather
than as a full green bar (`src/report/terminal.test.ts`: `renders a family with nothing measured as not
measured, not as 100`).

15 of those 427 routes are unmeasured because `isTrivial` (`src/triviality.ts`) rules them out before
any check runs. Trivial means a body of three statements or fewer, three or fewer calls, no
try/catch, no builder wrapping it, and nothing in the calls or the source naming a datastore or a
service (`prisma`, `logger`, `fetch`, `redis`, and the like). Parse the params, build a path,
redirect: nothing there for a check to find evidence in either way. Exclusion is a denominator exit,
not a credit: a trivial route's `score` is the same placeholder 100 that an unmeasured entry always
carries, and it is left out of every mean for the same reason.

## A route whose body is somewhere else

`export { action } from "./handler.server"` and `export const action = handleWebhook` are not
trivial routes. A redirect stub genuinely has nothing to instrument; a delegating route has work the
scanner cannot see. Both used to produce the same verdict, so moving a body into a `.server.ts`
file, an ordinary refactor, deleted the route from the metric while the report said nothing.

Delegating routes are now counted apart from the unmeasured ones, listed on a `DELEGATED` line and
carried in the JSON as `delegating`, the same treatment a parse failure gets and for the same
reason: the denominator is smaller than the entry point count and nothing about these routes has
been checked (`src/score.test.ts`: `refactoring a body out of the route file`,
`a route that delegates its body to another module`; `src/report/terminal.test.ts`: `reporting a route whose
body is in another module`). There are none in the tree today, which is exactly why it would have
gone unnoticed when someone wrote one.

## When a check declines to judge

The rule every applicability decision follows: **would this evidence necessarily be visible in the
body if it existed?**

A log call inside a catch would be, because the catch is right there in the body being read. So its
absence is evidence of absence and `request-context` fails the route. A guard on work that happens
inside an imported helper would not be, because neither the work nor the guard is in the body. So
`auth-boundary` reports not-applicable with a detail saying it could not verify, rather than
accusing the route of being unguarded. `resources.impersonation.ts` is the worked example: it calls
`clearImpersonation`, which authenticates and writes an audit row in `app/models/admin.server.ts`,
a file this tool never opens. Five of the 67 sensitive routes sit out for this reason today.

The failure mode this rule exists to prevent is a fix list whose top three entries are all wrong.
That happened, twice, and both times the cause was a check asserting something the evidence did not
support.

## Sensitivity, and the names the tool matches on

`auth-boundary`, `auth-scope` and `audit-trail` only look at routes `src/sensitivity.ts` calls
sensitive, and that cohort is the fix list's primary sort key, so what goes in it decides what a
reader sees first. 67 routes are in it today: credentials and tokens, envvars, billing and the two
billing settings the bare `billing` segment does not match, impersonation, membership and invites
and roles and the team page, the login surface, API keys, and org or project deletion.

Two rules hold the vocabulary honest.

Calling a guard can never be what makes a route sensitive. `requireAdminApiRequest` was on the
symbol list once and made 34 of the then 67 sensitive routes sensitive purely for being guarded,
which `auth-boundary` then passed every one of them for (`src/sensitivity.test.ts`: `does not treat
calling the admin guard as what makes a route sensitive`).

Every name and every segment has to exist. Half the symbol list once named nothing at all:
`Set.has` is exact, and `setImpersonation`, `createJWT`, `signJWT` and `updateEnvVars` are exported
nowhere in the webapp, so the symbol half of the classifier was quietly doing almost nothing.
`src/webappSymbols.test.ts` resolves every sensitive symbol, every path segment and every entry in
`auth-boundary`'s guard list against `apps/webapp/app` and the two packages the webapp
authenticates through, and fails if one stops resolving. The one exception is
`ANTICIPATED_SEGMENTS`, three words that name no route yet and are held to naming none.

The same test is what stops `auth-boundary`'s guard list rotting. That check used to match
`/^(require|authenticate)/`, so any callee at all beginning `require` cleared a sensitive route:
`requireSsoEntitlement`, a plan check, cleared the org SSO settings page, and a local
`requireValidParams(request)` would clear whatever route was written next. It also matched
`/Authenticated/`, which passed `resolveAuthenticatedEnv` on ten routes, a `findFirst` by
environment id that authenticates nothing. Both shapes are corpus entries now
(`fake-require-guard`, `fake-authenticated-lookup`): under the patterns they took the tree from 18
to 19 and raised five routes, and under the accept-list they raise nothing.

## Authenticated is not the same as scoped

All nine route builders authenticate the request, which is why `auth-boundary` passes a
builder-wrapped route. Their `authorization` option is optional and `apiBuilder.server.ts` runs the
RBAC gate inside `if (authorization)`, so a route can be authenticated and scoped to nobody. That is
the cross-org IDOR class `apps/webapp/CLAUDE.md` names: "A PAT route must resolve its target
org/project scoped to the caller's membership. Skipping it opens cross-org access."

`auth-scope` is the check that can say "authenticated but not scoped" as a finding in its own
right. It applies to 19 routes and 17 pass. It reads two things as scoping, and requires EVERY
builder-wrapped export of a file to have one of them: an `authorization` option with a real value,
or a query in that export's own handler filtered on the caller's own id
(`userId: authentication.userId`, `userId: user.id`).

An `ability.can(...)` call in the handler is deliberately not a third way. The same CLAUDE.md
passage says why: the OSS fallback ability is permissive
(`internal-packages/rbac/src/fallback.ts` returns `permissiveAbility` for a PAT and
`buildFallbackAbility(user.admin)` for a session, neither of which reads org membership), so an
ability check enforces the role while the membership-scoped query is the tenant floor.

The two routes that fail both resolve their target organization from the URL slug with no
membership filter, and put nothing but an ability check in front of it:
`_app.orgs.$organizationSlug.settings.sso/route.tsx` in its loader, whose `resolveOrg` is
`findFirst({ where: { slug } })`, and `_app.orgs.$organizationSlug.settings.team/route.tsx` in its
action, whose org id comes from `resolveOrgIdFromSlug`. Both were hand-read. The fix in each is to
put `members: { some: { userId } }` on the lookup.

That per-export rule is the load-bearing half. Both of those files scope themselves in their OTHER
export, so an entry-point-wide reading passed them, and the exposure is per export.

One thing to know before reading a score on any of these 19 routes. `auth-scope` is only applicable
when the route uses a builder, and `auth-boundary` passes any route that uses a builder, so
**`auth-scope` applicable structurally implies `auth-boundary` pass**: all 19 carry the same
`auth-boundary` detail, "authenticated by the builder". That free point is a third or a quarter of
each of their scores. The 19 average 59.7 as scored and 44.6 with `auth-boundary` taken out, and
`settings.team`, a confirmed cross-org exposure, scores 25 rather than 0 because of it. The score is
not wrong, since the builder does authenticate. It is just less informative here than it looks, and
the finding is the thing to read.

## Suppression

```ts
// obs-map-disable auth-boundary -- public by design, see ADR 12
```

The reason is mandatory: a suppression without one is ignored (`src/suppression.test.ts`: `ignores
a suppression with no reason`). The directive is read from comments only, so a string literal
quoting it does not switch a check off (`does not suppress from a directive quoted inside a string
literal`, and six more for template literals and JSX text).

It applies to the whole entry point, not to the line under it. It was called
`obs-map-disable-next-line`, which was untrue in a way that mattered: a directive on the last line
of a file switched a check off for everything above it. Genuine line scoping is not available,
because a finding is attached to an entry point and carries no line number to match against, so the
name was corrected instead. The old spelling is not honoured (`does not honour the old -next-line
spelling`).

A suppression cannot raise a score. The suppressed check leaves the numerator and the denominator,
and the result is capped by what the entry would have scored unsuppressed, so suppressing a failing
check holds the number still rather than improving it (`src/score.test.ts`: `does not raise the
score when a failing check is suppressed`; `scoring 100 and 0, suppressing every check on the
failing entry leaves the global at 50`), and `suppress-every-check` is the tree-scale version in
the corpus. What you buy is removal from the worklist with a reason on the record. The report prints how many suppressions are
in force so the practice stays visible.

## The gaming boundary

`request-context` checks that a failure-path log names a tenant field. It does not check that the
value is real. A codemod that added `environmentId` to every in-catch `logger.error` call, wiring it
up to the wrong variable or a constant, would move the score exactly as far as one that wired it up
correctly. Measured on the real tree: adding a synthetic `environmentId: "obs-map"` field to the
first object argument of all 139 in-catch log calls, with no other change, takes the global from 19
to 29 and the CONTEXT figure from 11 to 98. That measurement is a one-off script rather than a
corpus entry, because the corpus asserts that the score must not rise and this rewrite is supposed
to.

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
  imported from another module is ever opened. `auth-boundary` applies to 62 of the 67 sensitive
  entry points; the other 5 hand their work to an imported helper and are reported as unverified
  rather than unguarded.
- **A guard is matched by name, not by what it does.** The accept-list is 29 names read off the
  webapp, plus two `SOFT_GUARDS`. `src/webappSymbols.test.ts` proves each one is declared
  somewhere; nothing proves the declaration it found is the guard we meant. `authenticateAdmin` and
  `authenticatePlainRequest` are local helpers inside one route file each, so a second route
  declaring its own no-op function of either name would be credited.
- **Two guard names are only checked as far as being read.** `getUser` and `getUserId` answer with
  null instead of throwing, so calling one is not a boundary. They are credited only when the body
  binds the result and some condition reads it (`EntryPoint.checkedCallees`). What that cannot see
  is whether the test guards anything: `if (!user) { logger.warn("anonymous"); }` followed by the
  work reads the same as returning.
- **`authenticate` and `isAuthenticated` are unresolved on purpose.** They are remix-auth's, and
  resolving them meant reading a path inside `apps/webapp/node_modules`, which fails confusingly on
  an install-layout change. They are listed in `EXTERNAL_GUARDS` instead, so the resolution test
  still rejects a name that is neither first-party nor listed.
- **`auth-scope` cannot tell a caller-id filter from a caller-id actor argument.**
  `presenter.call({ userId: user.id })` narrows the query; `generatePortalLink({ organizationId,
  userId: user.id })` just records who asked. Both read as scoping. Separating them means following
  the argument into the callee, so the four helpers credited this way
  (`ApiKeysPresenter`, `TeamPresenter`, `regenerateApiKey`, `DeleteOrganizationService`, all of
  which do `members: { some: { userId } }` and throw) were hand-read instead. No route in the tree
  passes on an actor argument alone.
- **`auth-scope` reads property assignments in that export's own handler.** A handler that pulls the
  id into a local first, `const userId = user.id; ... { userId }`, or that builds its filter in a
  same-file helper, scopes itself and is not seen, so it would be reported as unscoped.
- **Three login-flow routes fail `auth-boundary` correctly and unhelpfully.** `/auth/sso`,
  `/api/v1/authorization-code` and `/api/v1/token` are unauthenticated by design: the caller is
  anonymous at that point, which is the whole purpose. The check's statement about them is true and
  there is nothing to fix, so they are candidates for a suppression comment with the reason on the
  record.
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
- **A catch inside a per-item callback is not the route's.** `items.map((item) => { try {...} })`
  is a fresh boundary per element, so its clause is not read as the route's own error handling. The
  test is the method name, which cannot tell `users.map` from `Result.map`. Being wrong there costs
  precision rather than points: a refused catch fails the route rather than excusing it, so no
  wrapper can turn a swallow into a not-applicable by getting the boundary rule to refuse it.
- **A route that delegates only one of its two exports is judged on the other.**
  `export { action } from "./x"` beside a loader written in the file is not counted as delegating,
  so half the route is scored and half is invisible.
- **`try { String(0); }` still buys a pass.** The open corpus entry, above. It is the largest single
  hole known in the tool: measured live, it takes the tree from 19 to 44 and raises 224 routes.
- **A forged tenant field buys a pass too.** The gaming boundary above, restated here because it
  belongs on this list: `request-context` reads the field name, never the value, so a codemod
  writing `environmentId: "obs-map"` into every in-catch log call takes the global from 19 to 29.
  Unlike the entry above this one is not a bug to fix, since no syntactic check can tell a real
  tenant id from a constant, but it bounds what the number can mean either way.
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
