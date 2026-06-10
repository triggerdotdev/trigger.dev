# Patches

This directory holds [pnpm patches](https://pnpm.io/cli/patch) applied on install via
`pnpm.patchedDependencies` in the root `package.json`. Each `.patch` is a diff against the
published package. Most are small and self-explanatory from the diff; the non-obvious ones
are documented below.

---

## `@remix-run/router@1.23.2` — route-matching memoization

**File:** `patches/@remix-run__router@1.23.2.patch` (patches `dist/router.cjs.js`)

### What it does

Three changes to `matchRoutesImpl` / `compilePath`, all pure memoization of work that
depends only on the **static** route manifest:

1. **Cache flattened + ranked branches per route-tree** (`WeakMap` keyed by the `routes`
   ref). `flattenRoutes()` + `rankRouteBranches()` were recomputed on *every* `matchRoutes`
   call across all ~436 webapp routes.
2. **Hoist `decodePath(pathname)` out of the branch-match loop** — it's loop-invariant but
   was recomputed once per branch.
3. **Memoize `compilePath` compiled regexes** by `path|caseSensitive|end` (bounded `Map`,
   cap 2000). The matcher RegExp was rebuilt on every `matchPath` call.

### Why

Profiling the realtime runs feed under load (100 concurrent tag feeds, ~425 req/s) found
**~68% of webapp CPU was spent in react-router's `matchRoutes`** — re-flattening,
re-ranking, and re-compiling the entire route table on every request. It is **not** a dev
artifact: there is no `NODE_ENV` gate, and a `NODE_ENV=production` profile was identical
(67.9% vs 68.3%). The realtime feed's high request rate (each long-poll returns fast and
immediately re-polls) just amplifies a latent per-request cost that large route tables pay
everywhere.

Measured on a single instance, same load, before vs after this patch:

| | before | after |
|---|---|---|
| active CPU (self-time / window) | 28.3s | 18.5s (**−34%**) |
| route-matching self-time | 19.2s | 7.5s (**−61%**) |
| event-loop lag p99 | 322ms | 113ms (**−65%**) |
| idle headroom | 26% | 52% |

The realtime machinery itself (router/hydrate/serialize/diff) was ~0% — the bottleneck was
entirely generic Remix request overhead.

### Upstream status (why we patch instead of upgrade)

This is a known, acknowledged inefficiency, and it is **only partially fixed in React
Router v7** — which we can't adopt without a full Remix 2 → RR7 framework migration.

- [Issue #8653 "Performance issues"](https://github.com/remix-run/react-router/issues/8653)
  reported it (a user with 12k routes, ~67ms per match) and was closed as a dup of the
  route-ranking discussion [remix#4786](https://github.com/remix-run/remix/discussions/4786).
- [PR #14866 "Optimize route matching performance with caching"](https://github.com/remix-run/react-router/pull/14866)
  implemented *exactly this patch* (hoist `decodePath`, cache `compilePath`, cache
  flatten/rank), claiming **~80% route-matching CPU reduction on a 400+ route app**. It was
  **closed, not merged.**
- [PR #14967 "perf: cache flattened/ranked route branches"](https://github.com/remix-run/react-router/pull/14967)
  is the partial fix that *did* ship (in v7): it caches only the branches, threaded via a
  `precomputedBranches` param through the framework's server-runtime (~15% SSR gain). It
  does **not** cache `compilePath` — that regex rebuild remains even on `main`.
  ([PR #14971](https://github.com/remix-run/react-router/pull/14971) added client-side wins.)

The maintainer's reasoning for closing the fuller PR (#14866), verbatim:

> "This is great as a `patch-package` optimization for those who want it, but we are
> actively working on integrating the more performant route-pattern library from Remix 3 so
> we'd rather just do the right 'fix' and ship the new algorithm instead of trying to
> band-aide perf improvements to the existing algorithm which was written with a very
> different set of constraints. Those constraints come from early v6 when it was only
> declarative mode so route trees were defined at render time and thus had to be
> re-flattened/re-ranked/re-compiled every time."

So: the re-compute-everything design is a holdover from early React Router v6 declarative
mode (route trees defined at render time, so recomputing was correct then). The maintainer
**explicitly endorsed patch-package as the interim approach** and is betting on the Remix 3
route-pattern rewrite for the real fix. This patch is that sanctioned stopgap — and it also
includes the `compilePath` cache the merged PR left on the table.

### Safety

Pure memoization of deterministic, internal-only values:

- `flattenRoutes`/`rankRouteBranches` and the compiled regexes depend solely on the static
  route manifest; the cached values are never returned to or mutated by the framework.
- The compiled `RegExp` has no `/g` flag, so `.exec()` carries no cross-call state — safe to
  share under concurrency.
- The branch cache is a `WeakMap` (collected with its route tree); the compile cache is
  bounded at 2000 entries (route patterns are a static set; the cap only guards any dynamic
  `matchPath()` use).
- Targets the **CJS** build (`dist/router.cjs.js`), which the webapp server loads at runtime
  (`@remix-run/router` is not bundled into the server build).

### When to remove

Drop this patch if/when the webapp moves to React Router v7+ (which threads
`precomputedBranches` itself) or the Remix 3 route-pattern matcher lands. Re-profile at that
point — the `compilePath` cache may still be worth keeping since upstream never added it.
