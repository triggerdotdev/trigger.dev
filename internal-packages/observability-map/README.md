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
against the tip of the base branch, with the score, what changed, and the current fix list. Every
comment names the head commit it was rendered for, as a link to the PR's compare range, because the
comment is edited in place across pushes and otherwise says nothing about which push it reflects. It
is report-only: nothing here fails the build or blocks a merge, and the gate stays deferred until a
later phase decides to add one. See `.github/workflows/observability-map.yml`.

The workflow itself runs on every PR, and the paths above are a gate inside it rather than a `paths:`
filter on the trigger. GitHub evaluates one of those per workflow, so a PR whose diff stops matching
does not start the workflow at all, and the comment an earlier push left then stands for ever showing
findings that are no longer in the diff. The case that matters is not a PR reverted to nothing: it is
one touching a route and other files whose author reverts the route change and keeps the rest, which
still has a diff and still does not match. So a PR with a comment and nothing left to compare gets
the comment reconciled to its resolved state without scanning anything, and a PR with neither pays
for one cheap job that reads the paths and looks for a comment.

This paragraph used to say "merge base", and two reviewers read that against
`github.event.pull_request.base.sha` and reported the workflow as the thing that was wrong. It is
the other way round. `actions/checkout` on a `pull_request` event checks out GitHub's test merge
commit, whose two parents are `base.sha` and the PR head, so the head tree being scanned already
contains everything on the base branch up to `base.sha`. Diffing that against `base.sha` isolates
the PR's own work, which is what the comment is for. A real merge base would be the wrong base
here: it would leave the intervening base-branch commits in the head tree and out of the base tree,
and attribute all of them to the pull request. `git merge-base HEAD <base.sha>` would not even do
that, since `base.sha` is a parent of `HEAD` and the command returns `base.sha` unchanged.

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
- **`auth-scope` reads the builder-wrapped exports and says nothing about the rest of the file.** A
  route whose action is builder-wrapped and whose loader is a plain `export async function loader`
  is judged on the action alone, and the pass detail, "every builder-wrapped export has an
  authorization gate", is true of what it read while reading as a claim about the whole route. Ten
  routes in the tree mix the two, and one of them is sensitive, so it is the only one the check runs
  on: `_app.orgs.$organizationSlug.settings._index/route.tsx`, whose builder-wrapped action carries
  the pass and whose plain loader filters on `members: { some: { userId } }` and is scoped. That was
  hand-read; nothing in the check saw it. Widening the check to a hand-written export means deciding
  first whether that export is authenticated at all, which is `auth-boundary`'s question rather than
  this one.
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

## How the scanner reads a route

`scan.ts` produces one `EntryPoint` per route module, carrying only body-scoped evidence. Three
rules decide what "the body" means, and every finding in this tool rests on them.

**One hop, same file only.** A loader that delegates to a helper declared in the same file has that
helper's statements, try/catch and callees counted as its own. A helper's own helpers are not
followed, the visited set stops a cycle, and nothing imported from another module is ever opened.

**Nested functions count as work.** A statement inside a callback written in the body is still a
statement the route runs. Leaving them out let `trace("x", async () => { whole body })` collapse a
route to one statement, which is inside the triviality limit, so every check reported
not-applicable for it. `wrap-body-in-trace` in the corpus is that shape.

**Per export, not per file.** Six fields come in `loaderX`/`actionX` pairs, and the union is only
offered where the question itself is file-wide. This split is the fix for a whole family of false
passes, all the same shape: a file whose loader called `requireUser` and whose action called
nothing read as "guarded in the body", and a file whose loader was `createLoaderApiRoute(...)`
credited its hand-written action with the builder's authentication. `routeExports.ts` is the one
enumeration both per-export checks read, because `auth-scope` and `auth-boundary` each grew their
own `[loader, action]` literal and only one of them got each fix.

`calleeNames` is the union and stays entry-point wide because the three questions that read it are:
`sensitivity.ts` asks what the file touches, `triviality.ts` asks how much the file does,
`audit-trail` asks whether the file records anything. There is deliberately no entry-point-wide
`checkedCallees`, so no check can reach for a union that would say a loader's reading of `getUser`
speaks for the action beside it.

The split cannot drift from the union it came from: one push site in `scanFile` fills the whole-entry
list and each owning export's list, `scan.test.ts` pins the property on fixtures and
`integration.test.ts` pins it again over the real tree (`every callee name is attributed to an
export that exists`).

Two fields exist because the bare callee name is not enough. `calleeName` keeps only the last
segment, so `prisma.organization.findFirst` arrives as `findFirst` with the receiver that says what
is being called gone; `calleeTexts` keeps the whole dotted path, which is how the per-export
triviality rule knows a three-statement body reaches the datastore. `auth-boundary` matches the bare
name on purpose, so a guard call cannot be hidden by its receiver.

### Catch evidence, per clause

`CatchEvidence` is one record per catch clause rather than a set of booleans per entry point,
because 39 routes have more than one catch and 17 mix a narrow parse guard with a broad handler.
Under the old aggregate booleans a single well-behaved catch spoke for the swallow next to it.

- `rethrows`: throwing is the clause's only way out, i.e. a throw is reached on the clause's
  guaranteed path AND the clause contains no live `return` anywhere.
- `throws`: a throw is reached on that path, whether or not it is the only way out. Kept separately
  so a verdict can say what is true of a clause that both throws and returns. The detail line "takes
  one way out regardless of what was thrown" is only true of a clause that never throws, and saying
  it of a clause that does was a false accusation on 16 clauses in the tree.
- `branches`: the clause picks what to do from what it caught. An `if` or `switch` whose condition
  references the caught binding and at least one of whose arms returns or throws, or a conditional
  that is the whole value of a `return`/`throw`. `if (retries > 0)` does not count,
  `if (e instanceof Error) { }` does not count, a bindingless `catch { }` cannot count at all, and an
  `instanceof` used only to word a message does not count either, because every error still leaves by
  the same path.
- `guardsParse`: the guarded region parses something. `JSON.parse`, `request.json()`, a zod
  `parse`/`safeParse`, a `decode`, or a `new URL`/`URLSearchParams`/`RegExp`. Those three
  constructors are read as `ts.isNewExpression` because a `new` expression is not a call and the
  call-callee scan never sees them. Any constructor at all would mean `new BranchesPresenter()`
  excuses a catch guarding ordinary work, which was true of 77 try blocks in the tree.
- `guardCanRaise`: the region does anything that could reach the clause. False means `try { 0; }` and
  little else, because any call counts, including one that cannot throw.
- `guardMayRaise`: the containment twin, false only when the region provably cannot raise. Everything
  `canRaise`'s whitelist misses stays true here, so `guardCanRaise` implies `guardMayRaise`.
- `awaitsOnlyParse`: everything the region waits for is one of those parses, or a read of the body it
  parses.
- `tryStatementCount`: statements in the guarded block, counted as `statementCount` counts them.

`canRaise` is a whitelist and it misses real raising code, which is the safe direction but does
matter: a destructuring declaration (`const { a } = undefined` throws), a temporal-dead-zone read, a
coercion that raises, and a `delete` on a frozen object all read as unable to raise. That is why the
refused-swallow arm of `error-classification` reads the route's own deciding catches through
`guardMayRaise` and never through `guardCanRaise`. Ordering it off can-raise accused a route that
owns a real classifying catch of owning none, which was flatly untrue (`does not accuse a route that
owns a catch of owning none`).

"Does this route catch anything" is `catches.length`, never `hasTryCatch`. A `try`/`finally` with no
catch leaves `hasTryCatch` true and `catches` empty: nothing is swallowed there, the error propagates
once the cleanup has run, and reading the old flag as a catch put
`admin.api.v1.runs-replication.status.ts` at the top of the first rendered fix list.

## The dead-code defence

Both of the catch-clause answers are read off the clause's guaranteed path. The governing rule: the
walk may enter a construct exactly where the entered statements are guaranteed to execute whenever
the clause body runs, so no credit can ever come from code a semantics-preserving edit could have
added dead.

Entered on those terms: a bare nested block, a `do` body, the tryBlock of a `try` that has no catch
clause and whose finally contains no jump out of itself, the sole clause of a single-default
`switch`, the then-arm of an `if` whose condition is exactly the literal `true` keyword, and both
arms of an `if`/`else` with per-arm states merged by intersection.

Not entered, deliberately: a bare `if` without an else, loops other than `do`, labelled statements,
function-like nodes, nested catch clauses, finally blocks, and the tryBlock of a `try` that has a
catch clause, where a throw is intercepted by the nested catch rather than escaping.

That rule replaced a list of statically-false shapes an earlier round kept extending, and the list
was losing. `if (false)` and `while (false)` were recognised; `for (;false;)`, `if (true) {} else`,
`switch (1) { case 2: }`, `try {} catch`, `for (const x of [])`, `for (const k in {})`, `if ("")`,
`if (!true)` and `if (1 === 2)` were not, each worth 50 points a route. Asking for the throw to be
unconditional refuses all eleven without naming any of them. `dead-*` in the corpus is the
tree-scale proof, one entry per shape.

`rethrows` asks for one thing more: no `return` anywhere in the clause. Without it a `throw error;`
written after a statement that already exited read as a rethrow, in seven spellings.
`dead-throw-after-*` in the corpus covers them. The cost is real and worth stating:
`catch (e) { if (transient) throw e; return null; }` no longer reads as a rethrow, so it fails rather
than sitting out. That is the direction to be wrong in, since the reverse hands out points.

### Two folds, pointing opposite ways

There are two literal folds in `scan.ts` and unifying them would be a bug.

`containsLiveWhere` folds any literal guard `literalTruth` can decide, and it is strictly
subtractive against a plain containment read: wherever the truth cannot be decided, every hit
containment would have found is still found. That is what lets its two callers read it for opposite
purposes. In `catchClauseEvidence`'s `exited` flag a hit BLINDS the walk to whatever follows, and
containment blinded it on a provably dead statement, so prepending one to a deciding clause turned
its pass into a swallow verdict on 78 real routes. In `selectsADistinctPath` a hit GRANTS a branch,
and containment granted one for an arm whose only exit was dead: `dead-armed-instanceof-if`, measured
at 80 routes and the tree from 19 to 27. Subtracting dead hits only ever un-blinds in the first case
and only ever withholds in the second.

The walk's own entry tickets fold nothing but the literal `true` keyword. `!!1`, `1` and `!false` are
deliberately not entry tickets, because entry GRANTS credit and a wrong grant pays, where
`literalTruth`'s wider folding only ever withholds blindness. Do not unify the two.

`literalTruth` treats `&&`, `||`, an identifier, a call, a bigint and a template with substitutions
as undecidable on purpose, so a live guard can never be read as dead. The cost of that is
`dead-conjunction-instanceof-if`, a corpus expected failure: `e instanceof Error && false` both
references the caught binding and can never be true, and no fold in the file can see it. Widening the
fold is a different rule with its own measurement.

The `exited` flag is raised at the END of each statement, after that statement's own branch check. A
deciding statement contains an exit by definition, so raising it first makes every such statement
refuse itself, measured at 78 routes losing their pass. This ordering leaves the real-tree report and
all 240 clauses' evidence byte-identical.

### A finally that cancels the try

A finally block that completes abruptly supersedes the try's and the catch's completion, so an exit
written in either never leaves the statement. Two places read that, in opposite directions.

`catchClauseEvidence` refuses to enter a catchless try whose finally holds a jump out of itself,
because entry grants rethrow credit and the throw would never escape the clause. The refusal is a
containment read, and it is over-approximate on purpose: a jump that only may run still refuses
(`refuses the tryBlock when the finally only may break`). `dead-throw-in-cancelled-try` in the corpus
is the tree-scale shape, worth 80 routes and 8 global points when measured.

`containsLiveWhere` then folds the same statement to its finally's own statements, so a refused
statement cannot blind the walk to the real classification below it (`keeps the classification after
a finally-break no-op`). A finally holding a `return` is covered by the explicit `containsLiveReturn`
read instead, because `try { throw e; } finally { return null; }` genuinely swallows.

### The residual both branch tests share

Two arms that produce the same outcome by different spellings still read as a real decision.
`if (e instanceof Error) { return json(x); } return Response.json(x);` counts and decides nothing,
and so does the `if` with no `else` whose arm returns what the statement after it returns. Telling
those apart needs the produced values compared for meaning rather than for text, which is a
different kind of analysis from anything else in the file. The textual comparison is the cheapest
thing that catches the copy-paste form, which is the one a mutation produces.

## Parse guards, and the narrow-try count

A catch clause counts as a parse guard, rather than as the route's error handling, when the try block
parses, waits for nothing except that parse, and is short. All three conditions are load bearing and
two of them are corrections.

`awaitsOnlyParse` is what a statement count cannot express.
`try { const body = await request.json(); return await handleEverything(body); } catch { 500 }` is
two statements, one of them a parse, and the whole handler inside it: the count reads it as narrow
and it is the `otel.v1.logs.ts` swallow written compactly. Asking what the block waits for separates
them, and unlike the count it does not care how the statements are punctuated or how deeply the work
is nested. Awaiting is the signal rather than calling, because the calls that prepare a parse's input
are ordinary synchronous string work (`matchPattern.slice(4)` before a `new RegExp`), and requiring
every CALL to be a parse refuses four of the tree's clearest guards.

Two residuals follow from awaiting being the signal, both in the round A fix 3 report. A block that
does its non-parse work synchronously still reads as a guard. And `guardedWork` looks for a
`ts.AwaitExpression`, which `for await (...)` and `await using` are not. Neither occurs in the tree
and neither is reachable by rewriting a real route, since both need work that is not there to begin
with.

`NARROW_TRY_STATEMENTS` is 2, so the guarded operation can bind its result
(`const stripped = ...; new RegExp(stripped);`) and a third statement means the try has started to
cover the handler. The idiom it was hand-read against: 55 of 427 entry points, 11 of the failures at
the time, all eleven the deliberate `try { body = await request.json() } catch { 400 }` shape.

It is an absolute count and not a ratio against the enclosing body, because a ratio is diluted by
anything else in the same body: padding the action with unrelated statements after the try relabelled
the same broad swallow as a narrow guard, moving the denominator without touching the clause.
`inert-statements-after-try` in the corpus is that shape.

What the count is not is unpaddable, which an earlier docstring and a commit subject both claimed.
`countStatement` counts declarators and comma operands rather than semicolons, so
`const a = f(), b = g(), c = h();` is three and `a(), b(), c()` is three; that is what
`merge-declarations` and `merge-comma-expressions` check. A third way nobody has written down would
work, which is why the count is no longer the only condition and no longer the load-bearing one.

Two rejected alternatives, both measured. Requiring the clause to answer with a 4xx credits, on its
own, 11 clauses guarding four to thirty statements, the widest swallows in the tree, including
`admin.api.v1.workers.ts`, whose 28-statement try answers every failure with a 400 carrying the
internal error message; added on top of the rest it costs three routes their pass, all three narrow
guards computing a fallback value rather than answering a request. And a narrow guard is not a way to
qualify as classification on its own: reading all eleven entry points that limb would clear found six
real swallows, including a silent run cancellation and two credential paths reporting a database
failure to the browser as a 400 with an internal message in it.

## The iteration-callback boundary

`items.map((item) => { try {...} })` is a fresh catch per element, so its clause is not the route's
own error handling. `trace(async () => {...})`, `mutateWithFallback({ pgMutation: ... })` and
`new ReadableStream({ start: ... })` all invoke their callback exactly once, so theirs is. The
structural signal is the method name, which is a list of eight, because nothing in a syntactic scan
can tell `users.map` from `Result.map`.

Being wrong here is asymmetric, and the direction that used to pay no longer does. A refused catch is
kept WITH its evidence, built by the same machinery as an own catch, and judged on what it does
rather than on where it sits. A refused swallow fails the route whenever nothing the route owns
decides, and that arm is deliberately not conditioned on the route owning no catches, so an own inert
rethrow catch cannot lift a refused swallow out of the verdict. A route whose only catches are refused
and none of them swallows sits out at not-applicable and never passes, which is what keeps a prepended
dead deciding `.map` from minting a pass on the 261 catchless routes. `dead-deciding-map` holds that
at tree scale.

That is what makes the name list survivable. `Result.map(...)` is a corpus entry that passes rather
than a hole: relocating a swallow behind the boundary still fails
(`still fails a swallow wrapped in a non-array receiver's .map(...)`), and relocating a decision earns
at most the route's exit from the denominator. A receiver that is an array literal of one element or
none is refused outright, since it cannot iterate.

The other direction still costs precision. A per-item callback under a callee the list does not know,
`pMap(items, cb)` or `Array.prototype.map.call(items, cb)`, is attributed to the route, so a
per-element catch that decides can carry it to a pass. No mutation of a real route produces it: a
route has to already be iterating for the shape to exist. It is a wrong verdict waiting for a route
to be written that way rather than a laundering path, and it is why the list is worth extending when a
new iteration helper shows up in the tree.

## What auth-scope reads as scoping

Three conditions, and the first version had only the middle one, which made the check free to defeat.
Prepending `const __unused = { anything: user.id };` to every body raised `settings.sso` and
`settings.team`, the only two findings `auth-scope` has ever produced and both confirmed cross-org
exposures. `dead-caller-scope-object` and `dead-caller-scope-userid` are the two halves of that
shape.

- The value has to be the caller's own id, anchored at both ends: the root is one of the auth
  bindings a builder hands the handler and the last segment is an identity field, so `user.name` is
  not a scope and neither is `run.userId`, which is a resource's owner.
- The property NAME has to be an identity field. Of the ten names that take a caller-id value in the
  route tree, `sub`, `value` and `consumerId` are the three that are not, and `anything: user.id` is
  what a mutation writes.
- The object has to be handed, through any depth of nesting, to a call that could narrow a read with
  it. Arrays count, so `{ OR: [{ userId }] }` still reaches its call.

The third condition is a denylist of sinks rather than an allowlist of query callees, and that is a
measurement. 72 distinct callees are handed a caller id across the route tree, running from
`prisma.project.findFirst` through `presenter.call` and `new DeleteProjectService().call` to bare
`regenerateApiKey`. No name pattern separates those from `sendToPlain`, so an allowlist would accuse
whichever route named its helper next, and a wrong accusation is the failure this check cannot
afford. The sinks refused are the log line and the response body, both of which take the very
`{ userId: user.id }` object a query filter takes: loggers account for 13 of the caller-id sites and
the two response serializers for 2 more. The shape is already in the tree rather than hypothetical,
in `engine.v1.dev.runs...attempts.start`, which logs `{ environmentId: ... }` beside the
`runStore.findRun` that earns its credit honestly. `log-caller-scope-userid` covers it at tree scale.

A callee with no readable name of its own is credited, because refusing it would ACCUSE the route,
and under-crediting beats accusing a route that is fine. `String({ userId: user.id })` therefore
reads as scoping, the same way `try { String(0); }` reads as error handling and for the same reason.

`authorization: undefined`, `null` and `false` are read as not declared, because
`apiBuilder.server.ts` gates every option behind `if (option)` and declaring one is what the check
credits.

## Triviality, in detail

Trivial means a body of three statements or fewer, three or fewer calls, no try/catch, no builder
wrapping it, and nothing in the calls or the hint text naming a datastore or a service.

Both limits are 3 because both real shapes need three: parse the params, build a path, redirect, or
an environment guard and two returns. Allowing a fourth call admits
`_app.orgs.$organizationSlug.settings/route.tsx`, which awaits two service calls; allowing a fourth
statement admits the routes that authenticate and then hand off to a presenter, which have real work
behind them; allowing a fifth admits an admin route that calls a service and hand-rolls its own error
responses.

The rule is deliberately reluctant, because a route wrongly called trivial is exempted and never
shows up in the report again. So `calleeNames` descends into the callee of every call at any depth
while `statementCount` stops at a nested function, which means the call count still catches bodies
the statement count reads as short. A builder means the config passed to it (`findResource`,
`authorization`) is work the scanner never walks, so the visible body is not the whole route. And a
try/catch is exactly what `error-classification` reads, so a body with one has an error path worth
reporting on however short it is.

One rule, two views, so the entry-point-wide answer and a single export's answer cannot drift. The
per-export view exists because a per-export verdict judged against a file-wide triviality rule
accuses the wrong half of a file: `auth.github.ts` is
`export let loader = () => redirect("/login")` beside an action that calls
`authenticator.authenticate`, and the file-wide rule called it non-trivial because the ACTION is not,
so `auth-boundary` accused a one-line redirect stub of missing an auth guard. `checks/index.test.ts`
pins both directions (`reports not-applicable for a redirect-stub loader beside a guarded action` and
`fails an export whose own body does real work unguarded`).

The two views differ in one term and the difference was measured both ways. The entry-point-wide view
matches the side-effect hints against the whole file, so an import of `prisma` disqualifies it even
when the query sits somewhere the scanner does not walk. A per-export view matches that export's own
callee PATHS instead. Reading the file's text into one export's verdict is the per-file-for-per-export
substitution the rule exists to damp, and it is defeatable: `log-caller-scope-userid` prepends a
`logger.error(...)` to every body, which with the term file-wide put the word `logger` in
`auth.github.ts` and turned its untouched one-line redirect loader from excused into accused. Emptying
the term instead is not the answer either: `calleeNames` keeps only a call's last segment, so
`prisma.orgMember.findMany` reads as `findMany` and a three-statement body that queries the datastore
matches no hint at all, which took five existing `auth-boundary` fixtures from `fail` to
`not-applicable`. The callee paths are body-scoped like the first option wants and name the receiver
like the second needs.

## Reading the directive out of the source

The suppression directive is read from a real parsed `ts.SourceFile`, and then filtered against the
spans the parser has already claimed as content. Both halves are needed.

Parsing rather than scanning is what stops a template literal with a substitution being rescanned as
ordinary code after `${x}`, and what makes JSX text a node at all. Filtering by span is what stops
the two comment-range lexers reading the start of such a node as a comment anyway, which they do
because `getLeadingCommentRanges` and `getTrailingCommentRanges` are raw lexers over source text from
an offset and consult no parse tree. A JSX text node that BEGINS with `//` or `/*` is the shape that
reached the real tree, in `resources.branches.create.tsx`'s `<InlineCode>//</InlineCode>`.

The filter is on the range's start offset falling inside a claimed span, not on the gap between a
token's full start and its start. A gap filter was tried and rejected: it loses a same-line trailing
comment and a comment inside a JSX expression container, both of which are real. Both lexers are
called at every token boundary, because which one returns a given comment depends on whether it
shares a line with the token before it.

Leaf tokens are walked through `.getChildren()` rather than `ts.forEachChild`, which skips bare
punctuation and keyword tokens. A comment can sit directly before one of those with nothing else
following it, the last line inside a block.

The mutation corpus does not cover any of this and cannot: a suppression can only lower an entry's
score, because `scoreEntry` caps it at the pre-suppression ratio, so suppression bugs are invisible
to a harness that watches for the score rising. They need ordinary unit tests, which is what
`suppression.test.ts` is: `jsx text is content, not a comment` is the four cases that fail without
the JSX filter, and the positive control beside it, `still reads a directive from a comment in a JSX
expression container`, is what stops the filter being widened until it eats real comments.

## The mutation harness

Every mutation is a TEXT rewrite driven by AST positions, never a reprint. A reprint would change
formatting everywhere and make a failure impossible to read; splicing at node positions leaves the
rest of the file byte-identical, so a corpus failure can be diffed down to the one construct that
moved. Overlapping edits are dropped inner-first, which is what "the outer rewrite won" means.

Neither kind of entry is ever executed. Semantics-preserving here means preserving the observable
behaviour of the route as written, which is what the scanner claims to measure. It is not a claim
that the mutated tree compiles against its real types.

**Splices go at the HEAD of a catch clause, not the tail.** 234 of the tree's 260 clauses end in a
`return` or a `throw`, so an appended shape was dead by ordering before the rule under test ever
looked at it: eleven entries reported touching 172 files while exercising 26 clauses. At the head
every clause is reachable. The shapes spliced this way are dead wherever they sit, so moving them
does not make the rewrite any less preserving.

**The harness's population is asserted against the scanner's.** `entryBodies` read two of the four
export forms `scan.ts` reads, missing `export const { action, loader } = builder(...)`,
`const { action } = builder(...); export { action };` and `export const action = route.action`, which
is 36 of the tree's entry points. No assertion could notice, because a mutation reaching fewer routes
lowers the score rather than raising it. `wraps a body in every non-delegating entry point the scanner
finds` pins it now, with `admin.tsx` the one named exclusion: its handler is a concise arrow with no
block for a block wrapper to wrap.

The same failure mode is why the registry assertion and the additive-class assertion are ungated
while everything else in the file needs `OBS_MAP_MUTATION_CORPUS=1`. `auth-scope` was added a round
after `suppress-every-check` was written and never added to its directive list, so the suppression
invariant went untested at tree scale for 19 routes while the entry's description said "every
check". Omitting a check from a sweep leaves its failures in place, which lowers the score, so the
corpus cannot catch its own omission by failing.

**The corpus deliberately disagrees with the scanner about where a handler sits.** `mutations.ts`
keeps its own copy of the builder handler shapes rather than importing them, because sharing the
scanner's notion would let a bug in that notion hide a laundering shape. Which exports exist is not
a judgement, though, and there the harness was simply behind, which is the distinction above.

**The anti-vacuity threshold is on sites, not only files.** A file count says a rewrite touched a
file, not that it reached anything inside it. The guard the design asked for, verdict movement,
cannot be used, and not for the reason an earlier note gave: plenty of defended entries move verdicts
hard (`delete-every-catch` takes the tree from 19 to 8), but the IDEAL defended shape is one the
scanner is blind to, and `dead-if-false` and the ten entries beside it are defended precisely because
the tree comes out identical. Requiring movement would fail exactly the entries that work best.

**A `lowers` exemption is a per-entry field with a reason, not a skip list.** An exempted entry must
still be falling, or the exemption is stale, and its falls must have exactly the measured residual
shape it was granted for: `error-classification` moving pass to not-applicable, every other check
unchanged, nothing moving to fail. Exactly two entries carry one, both non-array-receiver iteration
wrappers.

**A `KNOWN_GAPS` entry runs as `it.fails`,** so closing the hole later turns the file red until the
entry is moved out deliberately. Two are open: `dead-classifying-try-with-call`, the shape
`dead-classifying-try` only looked like it closed, and `dead-conjunction-instanceof-if`, the sibling
the arm-liveness fix does not close. Both are described above.
`dead-branch-after-if-true` used to be listed on a measurement that was wrong; raising the exit flag
after each statement's branch check rather than before is byte-identical on the real tree and closes
the shape, so the `if (true)` family needed no condition folding after all.

## Reporting

The score's own arithmetic has three rules that the report is built to keep honest.

Every denominator reads `rawChecks`, pre-suppression. `checks` is the display view. Suppressing the
one `request-context` or `audit-trail` finding on an entry must not shrink the gap denominators and
raise the printed percentage, on the same screen as a claim that suppression cannot do that. An
entry's score is capped by what it would have scored unsuppressed, which is how 33 became 50 became
100 before the cap existed.

`score` is 100 for an entry no scored check applied to, and that is a placeholder rather than a
verdict. Rendering it as a figure turned a route refactored down to a trivial body into a 67-point
improvement, and a trivial route gaining real work into the PR's worst regression, so the PR
comment's cell says "not measured" instead. `globalWithout` recomputes from `rawChecks` minus the
suppression cap, because lowering both figures by the same rule would leave the difference between
them saying something about suppressions rather than about the check.

`hasDelta` has to be true whenever `renderPrComment` would say something different, because anything
it misses is a change the pull request silently does not report. So it covers every figure the
comment renders: the global, the per-entry score, measured state and suppression set, an entry added
or removed, a check failing at head that did not at base, the parse failure count, the unknown
suppression warnings, the audit and context gaps, `delegating` and `checkContributions`. The
per-entry suppression set and the two gaps are the half that was missing, and it ran the dangerous
way: suppressing an already-failing check moves no score, no measured flag and no new failure, so a
pull request whose entire purpose was silencing findings posted nothing. What is defended is that the
union of the terms is complete rather than that each term is load bearing. Four are individually
reachable with a test each; the global, the removed-entry check and the per-entry score are shadowed
by another term today and are kept because which term shadows which depends on the shape of the
change. `MapReport.suppressions` is the one term deliberately left out, because its totals are summed
from the very per-entry arrays the loop compares.

Two sections of the PR comment grow with the tree and both are capped, because GitHub's comment limit
is 65,536 characters and a 422 loses the whole comment to the section warning about a typo. A
mistyped directive applied tree wide rendered 87,938 characters. The delegated list is capped at
fifteen rather than ten because a file name is one comma-separated item rather than a line naming
every known check, and the longest route file name in the tree is 130 characters.

The `AUDIT` line has one shape for every count and no branch on the count, because the branch carried
the bug: a zero used to print "No audit helper exists in the webapp", which is false. The count was
already correct, so the sentence was the only wrong thing.

A suppression whose id names no check is carried through to both renderers rather than dropped,
because dropping it silently is what made a typo look like an acknowledgement.

## Tests, timeouts and CI

`docstringReferences.test.ts` enforces that every test name a docstring in `src/` claims to be
covered by exists. The rule was asked for six times in prose and broken six times, most recently by a
docstring naming a test that was never written, so prose does not enforce itself. What is checked:
every backticked kebab-case token, every backticked glob against the corpus ids by prefix, and every
backticked prose phrase of five words or more with no code punctuation. What is not: a reference
written without backticks, a title of fewer than five words, a comment with no node after it
(leading ranges only, so a comment on the last line of a block is never scanned), and a `.test.ts`
file or `mutations.ts`, both exempted by name. The kebab half is the half that has actually failed.
Three negative controls run the same predicates over an invented docstring, so the guarantee does not
rest on `src/` currently happening to contain a bad reference.

The real-tree tests are gated by `TREE_SCAN_TIMEOUT`, which is a hang detector and nothing else.
Neither test asserts anything about how long a scan takes, so a number tight enough to be a
performance budget would only be a way to fail on a busy runner, and a performance budget that flakes
gets the whole suite marked unreliable. The old 30s was chosen on an idle machine and does flake.
Measured on an 8-core box, this file alone at load average 0.9: 6.3s to 6.4s for the scan, 10.8s to
11.2s for the sweep. Twenty-four runs as two batches of twelve concurrent copies on those same 8
cores: 24.2s to 34.0s for the scan and 27.6s to 39.7s for the sweep, with one of the first twelve
dying on a 30s timeout. That contention is not hypothetical: `unit-tests-internal.yml` runs twelve
concurrent shard processes on one runner. The local reproduction is harsher than CI on purpose,
twelve processes over 8 cores against the 32-vCPU runner's 0.375 per core, so 120s is 3x the worst
contended run measured. 60s was the other candidate and is not enough on those numbers.

Parse failures come from a `ts.Program`, not from the diagnostics array the parser hangs on the
source file, which is internal and which the compiler is free to rename. An undetected parse failure
shrinks the denominator and inflates the score, so it must not be the kind of thing a compiler
upgrade can switch off silently. The host hands the program the source file we already have, so
nothing is parsed twice; the cost is the program machinery, and a full scan of the real tree went
from about 850ms to about 1450ms over five runs of each.

The suite's turbo task is uncacheable. Its real inputs are mostly not its own files, they are
`apps/webapp/app`, `packages/plugins/src`, `internal-packages/rbac/src` and the workflow files, so
turbo replayed a pass recorded before a route changed: a route file with a syntax error in it fails
under vitest and came back FULL TURBO in 301ms with the failure cached as a success. `inputs` naming
`../../apps/webapp/...` does bust the cache but replaces turbo 1.x's default file set instead of
adding to it, which drops the package's own files from the hash. The reasoning lives in `turbo.json`
beside the config it explains.

Three roads reach this suite and all three are asserted. `pr_checks.yml` calls
`unit-tests-observability-map.yml` behind an `obsmap` paths filter and lists it in the `all-checks`
aggregate, without which a test job gates nothing: the first attempt put the job inside
`observability-map.yml`, which reads well and gates nothing, because `all-checks` needs an explicit
list of jobs and cannot see another workflow. The filter watches all of `apps/webapp/app` plus the
report workflow, because the suite reads more than the routes folder and a rename outside it matched
only `webapp`, ran no job, and broke the build for whoever pushed next. It deliberately does NOT name
this package or the two non-webapp roots: `internal` already matches `internal-packages/**` and
`packages/**` and `unit-tests-internal.yml` runs `turbo run test --filter "@internal/*"`, so naming
them here ran the suite twice on every PR touching the package. Widening `internal` to the route
paths instead was tried and rejected, since it runs all eighteen internal packages with postgres,
clickhouse, redis and electric to protect one test.

The report workflow's own text is asserted from `integration.test.ts`, because it is the one thing the
docstring checker cannot reach and the C1 defect was exactly that: two steps disagreeing about what a
missing comment id meant, under a comment claiming they agreed. The render step read it as "a comment
exists" and emitted the resolved state, the upsert step read it as "no id" and POSTed, so a transient
lookup failure either added a second marker comment beside the stale one or announced findings were
gone on a pull request that never had any. The sentinel pair those two shared is gone: the lookup
moved into the cheap `changes` job so the report job's gate could read it, the report job does not
start unless the lookup finished cleanly, and the id both steps use is one job output. Those are text
checks over the workflow rather than a parse of its semantics, so they catch the wiring coming apart
and nothing about whether GitHub agrees.

Both scan steps write their own file through `--out` rather than capturing stdout with a shell
redirect. `pnpm --filter` takes its recursive path and some versions announce
`Scope: N of M workspace projects` on it; a single line of that in head.json fails the renderer's
`JSON.parse` and the workflow degrades to the stale-report comment on every run, quietly and
permanently. It does not reproduce on the pinned 10.33.2, which was checked, and what is asserted is
the shape that cannot have the bug rather than the version that happens not to. The render step has
no `--out` to reach for, and a banner there puts a stray line in a markdown comment instead of
breaking a parse, so it is left alone.

The corpus runs on the package's own paths and on a schedule rather than on every route pull request.
It measures the tool's resistance to laundering, which only an edit to the tool can weaken, and it
costs four and a half minutes. The nightly is the other half of that trade: dropping the schedule
would leave tree drift uncovered rather than covered late.

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
