# Internals

How the scanner decides what it decides. Read [README.md](./README.md) first for what the tool
measures and how to run it; this file is for changing it.

Every rule here refuses a shape that would otherwise mint free points, and every rejected
alternative written down is one somebody has proposed.

## How the scanner reads a route

`scan.ts` produces one `EntryPoint` per route module, carrying only body-scoped evidence. Three
rules decide what "the body" means, and every finding rests on them.

**One hop, same file only.** A loader that delegates to a helper declared in the same file has that
helper's statements, try/catch and callees counted as its own. A helper's own helpers are not
followed, the visited set stops a cycle, and nothing imported from another module is ever opened.

**Nested functions count as work.** A statement inside a callback written in the body is still a
statement the route runs. Leaving them out lets `trace("x", async () => { whole body })` collapse a
route to one statement, inside the triviality limit, so every check reports not-applicable for it
(`wrap-body-in-trace`).

**Per export, not per file.** Six fields come in `loaderX`/`actionX` pairs, and the union is only
offered where the question itself is file-wide. The split refuses a family of false passes: a file
whose loader calls `requireUser` and whose action calls nothing reading as "guarded in the body", or
a file whose loader is `createLoaderApiRoute(...)` crediting its hand-written action with the
builder's authentication. `routeExports.ts` is the one enumeration both per-export checks read,
because `auth-scope` and `auth-boundary` each grew their own `[loader, action]` literal and only one
of them got each fix.

`calleeNames` is the union and stays entry-point wide because the three questions that read it are
file-wide: what the file touches, how much it does, whether it records anything. There is
deliberately no entry-point-wide `checkedCallees`, so no check can reach for a union that would say
a loader's reading of `getUser` speaks for the action beside it. One push site in `scanFile` fills
the whole-entry list and each owning export's list, so the two cannot drift (`every callee name is
attributed to an export that exists`, pinned on fixtures and again over the real tree).

Two fields exist because the bare callee name is not enough. `calleeName` keeps only the last
segment, so `prisma.organization.findFirst` arrives as `findFirst` with the receiver gone;
`calleeTexts` keeps the whole dotted path, which is how the per-export triviality rule knows a
three-statement body reaches the datastore. `auth-boundary` matches the bare name on purpose, so a
guard call cannot be hidden by its receiver.

### Catch evidence, per clause

`CatchEvidence` is one record per catch clause rather than a set of booleans per entry point,
because 39 routes have more than one catch and 17 mix a narrow parse guard with a broad handler, and
an aggregate lets the well-behaved clause speak for the swallow beside it.

- `rethrows`: throwing is the clause's only way out, i.e. a throw is reached on the clause's
  guaranteed path AND the clause contains no live `return` anywhere.
- `throws`: a throw is reached on that path, whether or not it is the only way out. Kept separately
  so a verdict can say what is true of a clause that both throws and returns; the detail line "takes
  one way out regardless of what was thrown" is true only of a clause that never throws.
- `branches`: the clause picks what to do from what it caught. An `if` or `switch` whose condition
  references the caught binding and at least one of whose arms returns or throws, or a conditional
  that is the whole value of a `return`/`throw`. `if (retries > 0)` does not count,
  `if (e instanceof Error) { }` does not count, a bindingless `catch { }` cannot count at all, and an
  `instanceof` used only to word a message does not count either, because every error still leaves
  by the same path.
- `guardsParse`: the guarded region parses something. `JSON.parse`, `request.json()`, a zod
  `parse`/`safeParse`, a `decode`, or a `new URL`/`URLSearchParams`/`RegExp`. Those three
  constructors are read as `ts.isNewExpression` because a `new` expression is not a call and the
  call-callee scan never sees them. Crediting any constructor would let `new BranchesPresenter()`
  excuse a catch guarding ordinary work, true of 77 try blocks in the tree.
- `guardCanRaise`: the region does anything that could reach the clause. False means `try { 0; }` and
  little else, because any call counts, including one that cannot throw.
- `guardMayRaise`: the containment twin, false only when the region provably cannot raise. Everything
  `canRaise`'s whitelist misses stays true here, so `guardCanRaise` implies `guardMayRaise`.
- `awaitsOnlyParse`: everything the region waits for is one of those parses, or a read of the body it
  parses.
- `tryStatementCount`: statements in the guarded block, counted as `statementCount` counts them.

`canRaise` is a whitelist and it misses real raising code, which is the safe direction but does
matter: a destructuring declaration (`const { a } = undefined` throws), a temporal-dead-zone read, a
coercion that raises, and a `delete` on a frozen object all read as unable to raise. So the
refused-swallow arm of `error-classification` reads the route's own deciding catches through
`guardMayRaise` and never through `guardCanRaise`, ordering it off can-raise being what accuses a
route that owns a real classifying catch of owning none.

"Does this route catch anything" is `catches.length`, never `hasTryCatch`. A `try`/`finally` with no
catch leaves `hasTryCatch` true and `catches` empty, and nothing is swallowed there: the error
propagates once the cleanup has run.

## The dead-code defence

Both of the catch-clause answers are read off the clause's guaranteed path. The governing rule: the
walk may enter a construct exactly where the entered statements are guaranteed to execute whenever
the clause body runs, so no credit can come from code a semantics-preserving edit could have added
dead.

Entered on those terms: a bare nested block, a `do` body, the tryBlock of a `try` that has no catch
clause and whose finally contains no jump out of itself, the sole clause of a single-default
`switch`, the then-arm of an `if` whose condition is exactly the literal `true` keyword, and both
arms of an `if`/`else` with per-arm states merged by intersection.

Not entered, deliberately: a bare `if` without an else, loops other than `do`, labelled statements,
function-like nodes, nested catch clauses, finally blocks, and the tryBlock of a `try` that has a
catch clause, where a throw is intercepted by the nested catch rather than escaping.

Do not replace the rule with a list of statically-false shapes to refuse. Asking for the throw to be
unconditional refuses eleven spellings, from `if (false)` and `for (;false;)` through
`switch (1) { case 2: }` and `for (const k in {})` to `if (1 === 2)`, each worth 50 points a route,
without naming any of them. `dead-*` in the corpus is the tree-scale proof, one entry per shape.

`rethrows` asks for one thing more: no `return` anywhere in the clause, or a `throw error;` written
after a statement that already exited reads as a rethrow, in seven spellings (`dead-throw-after-*`).
The cost is real, since `catch (e) { if (transient) throw e; return null; }` no longer reads as a
rethrow and so fails rather than sitting out. That is the direction to be wrong in, the reverse
handing out points.

### Two folds, pointing opposite ways

There are two literal folds in `scan.ts` and unifying them would be a bug.

`containsLiveWhere` folds any literal guard `literalTruth` can decide, and it is strictly subtractive
against a plain containment read: wherever the truth cannot be decided, every hit containment would
have found is still found. That is what lets its two callers read it for opposite purposes. In
`catchClauseEvidence`'s `exited` flag a hit BLINDS the walk to whatever follows, and containment
blinds it on a provably dead statement, so prepending one to a deciding clause turns its pass into a
swallow verdict on 78 routes. In `selectsADistinctPath` a hit GRANTS a branch, and containment grants
one for an arm whose only exit is dead (`dead-armed-instanceof-if`, 80 routes and the tree from 19 to
27). Subtracting dead hits only ever un-blinds in the first case and only ever withholds in the
second.

The walk's own entry tickets fold nothing but the literal `true` keyword. `!!1`, `1` and `!false` are
deliberately not entry tickets, because entry GRANTS credit and a wrong grant pays, where
`literalTruth`'s wider folding only ever withholds blindness. Do not unify the two.

`literalTruth` treats `&&`, `||`, an identifier, a call, a bigint and a template with substitutions
as undecidable on purpose, so a live guard can never be read as dead. The cost is
`dead-conjunction-instanceof-if`, a corpus expected failure: `e instanceof Error && false` both
references the caught binding and can never be true, and no fold in the file can see it. Widening the
fold is a different rule with its own measurement.

The `exited` flag is raised at the END of each statement, after that statement's own branch check. A
deciding statement contains an exit by definition, so raising it first makes every such statement
refuse itself, measured at 78 routes losing their pass. The ordering leaves the real-tree report and
all 240 clauses' evidence byte-identical.

### A finally that cancels the try

A finally block that completes abruptly supersedes the try's and the catch's completion, so an exit
written in either never leaves the statement. Two places read that, in opposite directions.

`catchClauseEvidence` refuses to enter a catchless try whose finally holds a jump out of itself,
because entry grants rethrow credit and the throw would never escape the clause. The refusal is a
containment read, over-approximate on purpose: a jump that only may run still refuses (`refuses the
tryBlock when the finally only may break`, and `dead-throw-in-cancelled-try` at tree scale, worth 80
routes and 8 global points).

`containsLiveWhere` then folds the same statement to its finally's own statements, so a refused
statement cannot blind the walk to the real classification below it (`keeps the classification after
a finally-break no-op`). A finally holding a `return` is covered by the explicit `containsLiveReturn`
read instead, because `try { throw e; } finally { return null; }` genuinely swallows.

### The residual both branch tests share

Two arms that produce the same outcome by different spellings still read as a real decision.
`if (e instanceof Error) { return json(x); } return Response.json(x);` counts and decides nothing, as
does the `if` with no `else` whose arm returns what the statement after it returns. Telling those
apart needs the produced values compared for meaning rather than for text. The textual comparison is
the cheapest thing that catches the copy-paste form, which is the one a mutation produces.

## Parse guards, and the narrow-try count

A catch clause counts as a parse guard, rather than as the route's error handling, when the try block
parses, waits for nothing except that parse, and is short. All three conditions are load bearing.

`awaitsOnlyParse` is what a statement count cannot express.
`try { const body = await request.json(); return await handleEverything(body); } catch { 500 }` is
two statements, one of them a parse, and the whole handler inside it: the count reads it as narrow
and it is the `otel.v1.logs.ts` swallow written compactly. Asking what the block waits for separates
them, and unlike the count it does not care how the statements are punctuated or how deeply the work
is nested. Awaiting is the signal rather than calling, because the calls that prepare a parse's input
are ordinary synchronous string work (`matchPattern.slice(4)` before a `new RegExp`), and requiring
every CALL to be a parse refuses four of the tree's clearest guards. Two residuals follow: a block
that does its non-parse work synchronously still reads as a guard, and `guardedWork` looks for a
`ts.AwaitExpression`, which `for await (...)` and `await using` are not.

`NARROW_TRY_STATEMENTS` is 2, so the guarded operation can bind its result
(`const stripped = ...; new RegExp(stripped);`) and a third statement means the try has started to
cover the handler. It is an absolute count and not a ratio against the enclosing body, because a
ratio is diluted by anything else in the same body: padding the action with unrelated statements
after the try relabels the same broad swallow as a narrow guard, moving the denominator without
touching the clause (`inert-statements-after-try`).

The count is paddable, which is why it is one condition of three rather than the load-bearing one.
`countStatement` counts declarators and comma operands rather than semicolons, so
`const a = f(), b = g(), c = h();` is three and `a(), b(), c()` is three (`merge-declarations`,
`merge-comma-expressions`), and a third way nobody has written down would work.

Two rejected alternatives, both measured. Requiring the clause to answer with a 4xx credits, on its
own, the 11 widest swallows in the tree, including `admin.api.v1.workers.ts`, whose 28-statement try
answers every failure with a 400 carrying the internal error message; added on top of the rest it
costs three narrow guards their pass for computing a fallback value rather than answering a request.
And a narrow guard is not a way to qualify as classification on its own: the eleven entry points that
limb would clear hold six real swallows, including a silent run cancellation and two credential paths
reporting a database failure to the browser as a 400 with an internal message in it.

## The iteration-callback boundary

`items.map((item) => { try {...} })` is a fresh catch per element, so its clause is not the route's
own error handling. `trace(async () => {...})`, `mutateWithFallback({ pgMutation: ... })` and
`new ReadableStream({ start: ... })` all invoke their callback exactly once, so theirs is. The
structural signal is the method name, a list of eight, because nothing in a syntactic scan can tell
`users.map` from `Result.map`.

Three rules keep the cheap direction from paying. A refused catch is kept WITH its evidence, built by
the same machinery as an own catch, and judged on what it does rather than on where it sits. A
refused swallow fails the route whenever nothing the route owns decides, and that arm is deliberately
not conditioned on the route owning no catches, so an own inert rethrow catch cannot lift a refused
swallow out of the verdict. A route whose only catches are refused and none of them swallows sits out
at not-applicable and never passes, which keeps a prepended dead deciding `.map` from minting a pass
on the 261 catchless routes (`dead-deciding-map`).

That is what makes the name list survivable. Relocating a swallow behind the boundary still fails
(`still fails a swallow wrapped in a non-array receiver's .map(...)`), and relocating a decision
earns at most the route's exit from the denominator. A receiver that is an array literal of one
element or none is refused outright, since it cannot iterate.

The other direction costs precision. A per-item callback under a callee the list does not know,
`pMap(items, cb)` or `Array.prototype.map.call(items, cb)`, is attributed to the route, so a
per-element catch that decides can carry it to a pass. No mutation of a real route produces it, since
a route has to already be iterating for the shape to exist, which makes it a wrong verdict waiting
for a route rather than a laundering path, and is why the list is worth extending when a new
iteration helper shows up.

## What auth-scope reads as scoping

Three conditions, all load bearing. With only the middle one, prepending
`const __unused = { anything: user.id };` to every body raises `settings.sso` and `settings.team`,
the only two findings `auth-scope` has ever produced and both confirmed cross-org exposures
(`dead-caller-scope-object`, `dead-caller-scope-userid`).

- The value has to be the caller's own id, anchored at both ends: the root is one of the auth
  bindings a builder hands the handler and the last segment is an identity field, so `user.name` is
  not a scope and neither is `run.userId`, which is a resource's owner.
- The property NAME has to be an identity field. Of the ten names that take a caller-id value in the
  route tree, `sub`, `value` and `consumerId` are the three that are not, and `anything: user.id` is
  what a mutation writes.
- The object has to be handed, through any depth of nesting, to a call that could narrow a read with
  it. Arrays count, so `{ OR: [{ userId }] }` still reaches its call.

The third condition is a denylist of sinks rather than an allowlist of query callees, and that is a
measurement: 72 distinct callees are handed a caller id across the route tree, from
`prisma.project.findFirst` through `presenter.call` to bare `regenerateApiKey`, and no name pattern
separates those from `sendToPlain`. An allowlist would accuse whichever route named its helper next,
which is the failure this check cannot afford. The sinks refused are the log line and the response
body, both of which take the very `{ userId: user.id }` object a query filter takes: loggers account
for 13 of the caller-id sites and the two response serializers for 2 more. The shape is in the tree
already, in `engine.v1.dev.runs...attempts.start`, which logs `{ environmentId: ... }` beside the
`runStore.findRun` that earns its credit honestly (`log-caller-scope-userid`).

A callee with no readable name of its own is credited, because refusing it would ACCUSE the route and
under-crediting beats accusing a route that is fine. `String({ userId: user.id })` therefore reads as
scoping, the same way `try { String(0); }` reads as error handling and for the same reason.

`authorization: undefined`, `null` and `false` are read as not declared, because
`apiBuilder.server.ts` gates every option behind `if (option)` and declaring one is what the check
credits.

An `ability.can(...)` call in the handler is deliberately not a third way to be scoped.
`apps/webapp/CLAUDE.md` says why: the OSS fallback ability is permissive
(`internal-packages/rbac/src/fallback.ts` returns `permissiveAbility` for a PAT and
`buildFallbackAbility(user.admin)` for a session, neither of which reads org membership), so an
ability check enforces the role while the membership-scoped query is the tenant floor.

## Sensitivity, and the names the tool matches on

Two rules hold the vocabulary honest, and tests rather than convention enforce both.

Calling a guard can never be what makes a route sensitive, because a mitigation cannot be the hazard
and the reading is circular: a guard name on the symbol list marks every route that calls it
sensitive, and `auth-boundary` then passes all of them for calling it (`does not treat calling the
admin guard as what makes a route sensitive`).

Every name and every segment has to exist. `src/webappSymbols.test.ts` resolves every sensitive
symbol, every path segment and every entry in `auth-boundary`'s guard list against `apps/webapp/app`
and the two packages the webapp authenticates through, and fails if one stops resolving, half the
symbol list having named nothing at all without it. The one exception is `ANTICIPATED_SEGMENTS`,
three words that name no route yet and are held to naming none.

That test is also why `auth-boundary`'s guard list is names rather than the patterns it replaced.
`/^(require|authenticate)/` cleared a sensitive route on any callee beginning `require`, so
`requireSsoEntitlement`, a plan check, cleared the org SSO settings page; `/Authenticated/` passed
`resolveAuthenticatedEnv` on ten routes, a `findFirst` by environment id that authenticates nothing.
Both are corpus entries (`fake-require-guard`, `fake-authenticated-lookup`): under the patterns they
took the tree from 18 to 19 and raised five routes, and under the accept-list they raise nothing.

## Triviality, in detail

Trivial means a body of three statements or fewer, three or fewer calls, no try/catch, no builder
wrapping it, and nothing in the calls or the hint text naming a datastore or a service.

Both limits are 3 because both real shapes need three: parse the params, build a path, redirect, or
an environment guard and two returns. A fourth call admits
`_app.orgs.$organizationSlug.settings/route.tsx`, which awaits two service calls; a fourth statement
admits the routes that authenticate and hand off to a presenter; a fifth admits an admin route that
calls a service and hand-rolls its own error responses.

The rule is deliberately reluctant, because a route wrongly called trivial is exempted and never
shows up in the report again. So `calleeNames` descends into the callee of every call at any depth
while `statementCount` stops at a nested function, which means the call count still catches bodies
the statement count reads as short. A builder means the config passed to it (`findResource`,
`authorization`) is work the scanner never walks, so the visible body is not the whole route. And a
try/catch is exactly what `error-classification` reads, so a body with one has an error path worth
reporting on however short it is.

One rule, two views, so the entry-point-wide answer and a single export's answer cannot drift. The
per-export view exists because a file-wide triviality rule accuses the wrong half of a file:
`auth.github.ts` is `export let loader = () => redirect("/login")` beside an action that calls
`authenticator.authenticate`, so a file-wide rule calls it non-trivial for the ACTION and
`auth-boundary` accuses a one-line redirect stub of missing an auth guard. `checks/index.test.ts`
pins both directions (`reports not-applicable for a redirect-stub loader beside a guarded action`,
`fails an export whose own body does real work unguarded`).

The two views differ in one term, measured both ways. The entry-point-wide view matches the
side-effect hints against the whole file, so an import of `prisma` disqualifies it even when the
query sits somewhere the scanner does not walk. The per-export view matches that export's own callee
PATHS instead, because matching the file's text is defeatable: `log-caller-scope-userid` prepends a
`logger.error(...)` to every body, which with a file-wide term puts the word `logger` in
`auth.github.ts` and turns its untouched redirect loader from excused into accused. Emptying the term
is not the answer either, since `calleeNames` keeps only a call's last segment, so
`prisma.orgMember.findMany` reads as `findMany` and a three-statement body that queries the datastore
matches no hint at all, which takes five `auth-boundary` fixtures from `fail` to `not-applicable`.
The callee paths are body-scoped and name the receiver, which is what both readings needed.

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
token's full start and its start, a gap filter losing a same-line trailing comment and a comment
inside a JSX expression container. Both lexers are called at every token boundary, because which one
returns a given comment depends on whether it shares a line with the token before it. Leaf tokens are
walked through `.getChildren()` rather than `ts.forEachChild`, which skips bare punctuation and
keyword tokens, and a comment can sit directly before one of those as the last line inside a block.

The mutation corpus cannot cover any of this: a suppression can only lower an entry's score, because
`scoreEntry` caps it at the pre-suppression ratio, so suppression bugs are invisible to a harness
watching for the score rising. They need ordinary unit tests. `jsx text is content, not a comment` is
the four cases that fail without the JSX filter, and the positive control beside it, `still reads a
directive from a comment in a JSX expression container`, is what stops the filter being widened until
it eats real comments.

## The mutation harness

Every mutation is a TEXT rewrite driven by AST positions, never a reprint. A reprint would change
formatting everywhere and make a failure impossible to read; splicing at node positions leaves the
rest of the file byte-identical, so a corpus failure can be diffed down to the one construct that
moved. Overlapping edits are dropped inner-first, which is what "the outer rewrite won" means.

Nothing is ever executed. Semantics-preserving means preserving the observable behaviour of the route
as written, which is what the scanner claims to measure, not that the mutated tree compiles against
its real types.

**Splices go at the HEAD of a catch clause, not the tail.** 234 of the tree's 260 clauses end in a
`return` or a `throw`, so an appended shape is dead by ordering before the rule under test ever looks
at it. At the head every clause is reachable, and the shapes spliced this way are dead wherever they
sit, so moving them does not make the rewrite any less preserving.

**The harness's population is asserted against the scanner's.** A mutation reaching fewer routes
lowers the score rather than raising it, so no invariant here can notice the harness missing an
export form. `wraps a body in every non-delegating entry point the scanner finds` pins it, with
`admin.tsx` the one named exclusion, its handler being a concise arrow with no block for a block
wrapper to wrap. The same failure mode is why the registry assertion and the additive-class
assertion are ungated while everything else in the file needs `OBS_MAP_MUTATION_CORPUS=1`: omitting a
check from a sweep leaves its failures in place, which lowers the score, so the corpus cannot catch
its own omission by failing.

**The corpus deliberately disagrees with the scanner about where a handler sits.** `mutations.ts`
keeps its own copy of the builder handler shapes rather than importing them, because sharing the
scanner's notion would let a bug in that notion hide a laundering shape. Which exports exist is not a
judgement, though, which is the distinction above.

**The anti-vacuity threshold is on sites, not only files,** a file count saying a rewrite touched a
file rather than that it reached anything inside it. Verdict movement cannot be the guard instead:
the IDEAL defended shape is one the scanner is blind to, so `dead-if-false` and the ten entries
beside it are defended precisely because the tree comes out identical, and requiring movement would
fail exactly the entries that work best.

**A `lowers` exemption is a per-entry field with a reason, not a skip list.** An exempted entry must
still be falling, or the exemption is stale, and its falls must have exactly the measured residual
shape it was granted for: `error-classification` moving pass to not-applicable, every other check
unchanged, nothing moving to fail. Exactly two entries carry one, both non-array-receiver iteration
wrappers.

**A `KNOWN_GAPS` entry runs as `it.fails`,** so closing the hole later turns the file red until the
entry is moved out deliberately. Two are open, both described above:
`dead-classifying-try-with-call` and `dead-conjunction-instanceof-if`.

## Reporting

Every denominator reads `rawChecks`, pre-suppression; `checks` is the display view. Suppressing the
one `request-context` or `audit-trail` finding on an entry must not shrink the gap denominators and
raise the printed percentage, on the same screen as a claim that suppression cannot do that. An
entry's score is capped by what it would have scored unsuppressed.

`score` is 100 for an entry no scored check applied to, a placeholder rather than a verdict.
Rendering it as a figure turns a route refactored down to a trivial body into a 67-point improvement,
and a trivial route gaining real work into the pull request's worst regression, so the PR comment's
cell says "not measured" instead. `globalWithout` recomputes from `rawChecks` minus the suppression
cap, because lowering both figures by the same rule would leave the difference between them saying
something about suppressions rather than about the check.

`hasDelta` has to be true whenever `renderPrComment` would say something different, because anything
it misses is a change the pull request silently does not report. It covers the global, the per-entry
score, measured state and suppression set, an entry added or removed, a check failing at head that
did not at base, the parse failure count, the unknown suppression warnings, the audit and context
gaps, `delegating` and `checkContributions`. The per-entry suppression set and the two gaps are the
terms that run the dangerous way, since suppressing an already-failing check moves no score, no
measured flag and no new failure, so without them a pull request whose entire purpose was silencing
findings posts nothing. What is defended is that the union is complete, not that each term is load
bearing: three terms are shadowed by another today and kept because which shadows which depends on
the shape of the change. `MapReport.suppressions` is deliberately left out, its totals being summed
from the very per-entry arrays the loop compares.

Two sections of the PR comment grow with the tree and both are capped, because GitHub's comment limit
is 65,536 characters and a 422 loses the whole comment to the section warning about a typo: a
mistyped directive applied tree wide renders 87,938 characters. The delegated list is capped at
fifteen rather than ten because a file name is one comma-separated item rather than a line naming
every known check, and the longest route file name in the tree is 130 characters.

The `AUDIT` line has one shape for every count and no branch on the count, the count being correct
and the branch being where a false sentence gets written. A suppression whose id names no check is
carried through to both renderers rather than dropped, because dropping it silently makes a typo look
like an acknowledgement.

## Tests, timeouts and CI

**The docstring checker.** `docstringReferences.test.ts` enforces that every test a docstring in
`src/` names exists, the rule having been asked for six times in prose and broken six times. It reads
every backticked kebab-case token, every backticked glob against the corpus ids by prefix, and every
backticked prose phrase of five words or more with no code punctuation. It does not read a reference
written without backticks, a title of fewer than five words, a comment with no node after it (leading
ranges only, so a comment on the last line of a block is never scanned), or a `.test.ts` file or
`mutations.ts`, both exempted by name. Three negative controls run the same predicates over an
invented docstring, so the guarantee does not rest on `src/` happening to contain a bad reference.

**`TREE_SCAN_TIMEOUT` is a hang detector, not a budget.** Neither real-tree test asserts anything
about how long a scan takes, so a number tight enough to be a performance budget is only a way to
fail on a busy runner. Measured on an 8-core box: 6.3s for the scan and 10.8s for the sweep
uncontended, rising to 34.0s and 39.7s under twelve concurrent copies, with one run dying on a 30s
timeout. `unit-tests-internal.yml` runs twelve concurrent shard processes on one runner, so that
contention is what CI does. 120s is 3x the worst contended run measured; 60s is not enough.

**Parse failures come from a `ts.Program`,** not from the diagnostics array the parser hangs on the
source file, which is internal and which the compiler is free to rename. An undetected parse failure
shrinks the denominator and inflates the score, so it must not be the kind of thing a compiler
upgrade can switch off silently. The host hands the program the source file we already have, so
nothing is parsed twice; the cost is the program machinery, about 850ms to about 1450ms on a full
scan of the real tree.

**The turbo task is uncacheable,** because its real inputs are mostly not its own files: they are
`apps/webapp/app`, `packages/plugins/src`, `internal-packages/rbac/src` and the workflow files, so
turbo replays a pass recorded before a route changed and caches a failure as a success. `turbo.json`
carries the reasoning and the rejected `inputs` alternative beside the config.

Three roads reach the suite and all three are asserted. `pr_checks.yml` calls
`unit-tests-observability-map.yml` behind an `obsmap` paths filter and lists it in the `all-checks`
aggregate, without which the job gates nothing, `all-checks` needing an explicit list of jobs and
being unable to see another workflow. The filter watches all of `apps/webapp/app` plus the report
workflow, because the suite reads more than the routes folder and a rename outside it matched only
`webapp`, ran no job, and broke the build for whoever pushed next. It deliberately does NOT name this
package or the two non-webapp roots, since `internal` already matches `internal-packages/**` and
`packages/**` and `unit-tests-internal.yml` runs `turbo run test --filter "@internal/*"`, so naming
them here runs the suite twice on every pull request touching the package. Widening `internal` to the
route paths instead runs all eighteen internal packages with postgres, clickhouse, redis and electric
to protect one test.

The report workflow's own text is asserted from `integration.test.ts`, because it is the one thing
the docstring checker cannot reach. What those checks pin: the comment lookup sits in the cheap
`changes` job so the report job's gate can read it, the report job does not start unless the lookup
finished cleanly, and the id both steps use is one job output, so no two steps can disagree about
what a missing id means and turn a transient lookup failure into a duplicate comment or a false
all-clear. Both scan steps write their own file through `--out` rather than capturing stdout,
because
`pnpm --filter` takes its recursive path and some versions announce
`Scope: N of M workspace projects` on it, and a single line of that in head.json fails the renderer's
`JSON.parse` and degrades the workflow to the stale-report comment permanently. What is asserted is
the shape that cannot have the bug rather than the pinned 10.33.2 that happens not to.

The render step writes through `--out` for the same reason, and its failure mode is the worse of the
two. `renderPrComment` puts the marker on the first line and the lookup finds the comment with
`startswith` on it, so a line printed ahead of the document does not degrade the comment, it hides it:
the next push finds no id and posts a second comment, and no later run can reconcile either. The scan
steps degrade to a stale report, which at least stays one comment.

The corpus runs on the package's own paths and on a schedule rather than on every route pull request,
because it measures the tool's resistance to laundering, which only an edit to the tool can weaken,
and it costs a couple of minutes of a runner. The nightly covers tree drift late rather than not at
all.
