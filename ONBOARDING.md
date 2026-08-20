# Onboarding: taking over the hosted webhooks PR (#4344) for design

You are picking up **PR #4344 "hosted webhooks, agent channels, and human-in-the-loop"** to own the UX and front-end. This doc gets you from a clean machine to a running dashboard with realistic webhook data you can screenshot, restyle, and iterate on.

The feature is built and green (all backend plumbing, all four dashboard surfaces, the in-app test console). Your job is the visual and interaction design of the dashboard surfaces, not the backend. Everything below is oriented around that.

---

## 1. What you are designing

Hosted webhooks let a Trigger.dev user receive and verify a provider's webhooks (Stripe, GitHub, and so on) as a task, with no ingress or verification code of their own. A `webhook()` handler in their project gets a hosted URL; deliveries to that URL are verified, recorded, and routed to their `onEvent` handler.

The dashboard has **four surfaces you own**, all under the "Webhooks" nav section (teal icon):

| Surface | Route (under `/orgs/:org/projects/:project/env/:env`) | What it shows |
| --- | --- | --- |
| **Deliveries list** | `/webhooks` | Every delivery across all endpoints in the environment. Runs-style filter bar (Status, Webhook, Created, plus a More-filters menu for Delivery ID / Run ID), applied-filter pills, a Webhook column linking to the handler. This is the main screen. |
| **Delivery detail** | `/webhooks/deliveries/:deliveryParam` | One delivery. Main panel is a tabbed view (Event payload / Request headers) rendered as JSON. Sidebar property table (status badge, webhook + run links, external delivery id, idempotency key, timestamps, computed duration, error). Also has a friendly "not available / retained for N days" empty state for expired or bogus links. |
| **Handler detail + Console** | `/webhooks/:webhookParam` | The handler (the `webhook()` in the user's code). Tabs: Deliveries, Runs, Endpoints. This page also hosts the **Webhook Console / Composer** (see section 5), the tool you will lean on for data. |
| **Endpoint detail** | `/webhooks/endpoints/:endpointParam` | One endpoint. Left: scoped deliveries. Right: a **Connect** card (webhook URL, signing secret set/rotate/generate, provider setup rendered from the verifier config), Routing, Scope, Metadata. |

The status vocabulary, badges, and colors live in `components/webhookDeliveries/v1/DeliveryStatus.tsx` and `components/webhookEndpoints/v1/EndpointStatus.tsx`. The nav accent color is a Tailwind token `--color-webhooks` (teal), used via `text-webhooks`.

---

## 2. Get the code

You need the PR branch, `feat/hosted-webhook-ingress`.

```bash
git clone https://github.com/triggerdotdev/trigger.dev.git
cd trigger.dev
gh pr checkout 4344    # lands you on feat/hosted-webhook-ingress
```

If you plan to push design changes back to this branch, coordinate with Eric first: the branch is rebased and force-pushed periodically, so agree on timing or work on a child branch and open a follow-up.

Toolchain: pnpm 10.33.2 via corepack, Node 22+. Use `corepack pnpm` (a bare `pnpm` can be an old global that wipes `node_modules`).

```bash
corepack enable
corepack pnpm install
```

---

## 3. Bring the stack up

Four services and the webapp. Run from the repo root.

```bash
# 1. Core dev services: Postgres, Redis, Electric, MinIO, ClickHouse, s2-lite
corepack pnpm run docker

# 2. Config
cp .env.example .env
```

Now edit `.env` and add the two webhook-delivery replication lines (they are NOT in `.env.example`, and without them the Deliveries list looks empty even after you send webhooks, see section 5):

```bash
# webhook deliveries replication (required for the Deliveries list/detail to populate)
WEBHOOK_DELIVERIES_REPLICATION_CLICKHOUSE_URL=http://default:password@localhost:8123
WEBHOOK_DELIVERIES_REPLICATION_ENABLED=1
```

Then migrate, seed, build, and run:

```bash
corepack pnpm run db:migrate
corepack pnpm run db:seed        # creates the References org + hello-world project

# Build the pieces you will run (do these sequentially, not with db:seed running)
corepack pnpm run build --filter webapp --filter trigger.dev --filter "@trigger.dev/sdk"

# Run the webapp (http://localhost:3030)
corepack pnpm run dev --filter webapp
curl -s http://localhost:3030/healthcheck   # verify
```

**Log in (dev):** open http://localhost:3030, submit the email `local@trigger.dev`. Dev auto-verifies the magic link (watch the webapp log for `/magic?token=`). That seeded user is an org admin, which matters for the next step.

---

## 4. Turn the feature on

The dashboard is gated by a feature flag, `hasWebhooksAccess` (default off).

- The seeded dev user `local@trigger.dev` is an **admin**, and admins bypass the flag, so on a fresh seed the Webhooks nav section is already visible to you. Nothing to do.
- If you use a non-admin user, set `featureFlags.hasWebhooksAccess = true` on the `Organization` row to reveal the nav section. (A global `FeatureFlag` row with key `hasWebhooksAccess` makes the pages reachable by URL, but the left nav reads only org-level flags, so the section stays hidden for non-admins.)

If the "Webhooks" section is missing from the left nav, this flag is why.

---

## 5. Get nice data (the part that matters)

Delivery rows are what make these screens interesting: a spread of providers, statuses, payloads, timestamps. Here is how the data flows and how to produce it.

### The pipeline (why an empty list is usually a setup issue, not a bug)

`ingest -> engine (verify, filter, route) -> Postgres WebhookDelivery rows -> replication -> ClickHouse`. The Deliveries **list orders and paginates from ClickHouse**, then hydrates every visible field from Postgres. So if replication is off (section 3), you can create deliveries and still see an empty list. Enable the two replication env vars and restart the webapp.

One caveat baked into the design: replication starts streaming from the moment it is enabled, so deliveries written **before** you turned it on will not appear. Turn replication on first, then generate data.

### Fastest path: the seed script

There is a seed script that inserts a full, stable dataset directly into both stores (Postgres and ClickHouse), so you get realistic screens on a fresh DB with no workers, no `trigger dev`, and no signing secrets to set:

```bash
corepack pnpm --filter webapp run db:seed:webhooks
# optional: deliveries per endpoint (default 45)
corepack pnpm --filter webapp run db:seed:webhooks -- 60
```

It creates six endpoints across different providers and verifier schemes (Stripe, GitHub, Slack, Svix, Discord, and a custom shared-secret one, with a mix of active/inactive and secret-set/not-set), then a spread of deliveries over the last two weeks covering **every** delivery status (SUCCEEDED, FAILED, FILTERED, PENDING, PROCESSING), realistic per-provider payloads and headers, and a mix of test and live. It attaches to the first DEVELOPMENT environment your local user can see (set `WEBHOOK_SEED_PROJECT="<project name>"` to target a specific one), and prints the exact Deliveries URL when it finishes. Re-running clears and reseeds that environment, so you always get the same clean dataset. The script is `apps/webapp/seed-webhook-deliveries.ts`; edit the `ENDPOINTS` array or the status weights to shape the data to whatever you are designing.

Because it writes the ClickHouse rows directly, seeded data shows up **without** the replication setup in section 3. That replication env is only needed for the live and Composer paths below. (The seed uses `WEBHOOK_DELIVERIES_REPLICATION_CLICKHOUSE_URL` if set, otherwise `CLICKHOUSE_URL`, which is already in `.env.example`.)

This is the recommended way to get data. The interactive paths below are for exercising the live pipeline (real verification, real routed runs) or the in-app test console.

### Interactive: create an endpoint (one-time)

The Composer sends to an endpoint, and endpoints only exist once a Trigger project that declares a `webhook()` has been dev-run or deployed. Quickest path: a tiny demo project.

```ts
// demo/src/trigger/demo-webhook.ts
import { webhook, webhooks } from "@trigger.dev/sdk";

export const demoWebhook = webhook({
  id: "demo-webhook",
  source: webhooks.custom<{ message: string }>({ /* generic HMAC */ }),
  onEvent: async ({ event, headers, ctx }) => {
    // event is the parsed body, headers is a Web Headers object
  },
});

// A real provider, for realistic payloads:
export const stripeWebhook = webhook({
  id: "stripe-webhook",
  source: webhooks.stripe(),
  onEvent: async ({ event }) => {},
});
```

Link that demo project to your local build and run `trigger dev` (see `AGENTS.md` "Testing with the hello-world Reference Project" for linking; the `triggerdotdev/references` repo has ready-made projects). Running `trigger dev` registers the `webhook()` handlers, which creates their endpoints. Set each endpoint's signing secret from the **endpoint detail Connect card** (Generate or paste).

### Interactive: fire deliveries with the Webhook Console

Open the handler detail page (`/webhooks/:webhookParam`). It hosts the **Composer** (`components/webhookConsole/WebhookComposer.tsx`). It has four source tabs and four signature modes, and it injects the delivery straight through the engine in-process, so it is fast and does not consume any real rate budget:

- **Sample tab**: pick a real provider event from the built-in catalog (`@internal/webhook-sources`, six first-class providers plus a large sample manifest). This is the fastest way to get realistic Stripe / GitHub / Svix / Square / Discord payloads with correct-looking headers.
- **Body tab**: hand-write any JSON.
- **Replay tab**: re-send a prior delivery.
- **AI tab**: generate a payload with a prompt.
- **Signature modes** `signed | unsigned | tampered | simulate`: this is how you produce a **spread of delivery statuses**. `signed` (with a secret set) verifies and routes to a SUCCEEDED delivery; `unsigned` and `tampered` produce failed/rejected deliveries. Send a mix to populate every status badge you need to design.

To get SUCCEEDED deliveries whose **runs** also complete (nicest end-to-end data), keep the demo project's `trigger dev` running so the routed task actually executes.

### Interactive: a real provider (most realistic)

For genuine payloads and headers, point the Stripe CLI at an endpoint: `stripe listen --forward-to http://localhost:3030/webhooks/v1/ingest/<opaqueId>`, set that endpoint's `whsec` via the Connect card, then `stripe trigger payment_intent.succeeded`.

---

## 6. Where the front-end code lives

| Area | Path |
| --- | --- |
| Routes (pages) | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.webhooks*` |
| Deliveries list / detail components | `apps/webapp/app/components/webhookDeliveries/v1/` (`DeliveriesTable`, `DeliveryStatus`, `WebhookDeliveryFilters`, `DeliveryTimeline`, `useDeliveriesLiveReload`) |
| Endpoint components | `apps/webapp/app/components/webhookEndpoints/v1/` (`EndpointsTable`, `EndpointStatus`) |
| Console / Composer | `apps/webapp/app/components/webhookConsole/` (`WebhookComposer`, `SampleSourcePicker`, `ReplaySourcePicker`) |
| Data (presenters, read-only from your side) | `apps/webapp/app/presenters/v3/WebhookDeliveriesListPresenter.server.ts`, `WebhookDeliveryDetailPresenter.server.ts`, `WebhookDetailPresenter.server.ts`, `webhookComposerEndpoints.server.ts` |
| Nav entry | `apps/webapp/app/components/navigation/SideMenu.tsx` (the `staticSections` "webhooks" push) |
| Path builders | `apps/webapp/app/utils/pathBuilder.ts` (`v3WebhooksPath`, `v3WebhookDeliveryPath`, `v3WebhookEndpointPath`, `v3WebhookTaskPath`) |
| Accent color token | `apps/webapp/app/tailwind.css` (`--color-webhooks`, used as `text-webhooks`) |
| Data seed script | `apps/webapp/seed-webhook-deliveries.ts` (run via `db:seed:webhooks`) |

**Styling:** the webapp is on Tailwind v4 (CSS-first `@theme` in `apps/webapp/app/tailwind.css`, there is no `tailwind.config.js`). Add or change design tokens there.

**Design language to match:** these screens deliberately reuse the Runs page primitives (the filter bar is built from `RunFilters` / `SharedFilters`, the tables mirror the Runs table cells). Match the Runs and Sessions pages, not a new visual system.

---

## 7. Iterating

- **HMR vs restart:** editing a component (`.tsx`) hot-reloads. Editing a `.server.ts` file makes the Remix dev server restart the app (a brief connection refused, then it comes back). Editing Tailwind tokens hot-reloads.
- **Screenshots:** capture from the running dashboard at http://localhost:3030. Save shots outside the repo or to a scratch folder so they do not get committed.
- **Typecheck after non-trivial changes:** `corepack pnpm run typecheck --filter webapp` (about 1 to 2 minutes). For small style tweaks, trust it and let CI catch anything.
- **One boundary gotcha that the dev server will NOT catch:** route files must not leak server-only imports into the client bundle. The dev server tolerates it, but the production build fails. If you touch a route file and import anything server-only, run `corepack pnpm --filter webapp run build:remix` before pushing. Pure component and style edits are unaffected.

---

## 8. Shipping your changes

Follow the repo PR workflow:

- Format and lint before committing: `corepack pnpm run format` (oxfmt) and `corepack pnpm run lint:fix` (oxlint). CI enforces both.
- Commit style is Conventional Commits, for example `feat(webapp): redesign webhook deliveries table`. No emoji, no attribution footer.
- The PR is a **draft** awaiting an AI review pass, then a human review, before it flips to ready. Do not flip it to ready yourself; push your commits and let Eric coordinate the review and any rebase onto `main`.
- CI to expect: `code-quality` (oxfmt + oxlint), `typecheck`, webapp unit shards, and the Playwright `e2e-webapp` job. Style-only changes usually only risk `code-quality`.

---

## 9. Quick reference

- **Webapp:** http://localhost:3030 (port comes from `REMIX_APP_PORT`, falling back to `PORT`/3030).
- **Default docker services:** Postgres 5432, Redis 6379, ClickHouse HTTP 8123 (`default:password`), MinIO, Electric, s2-lite.
- **Feature flag:** `hasWebhooksAccess` (admins bypass).
- **Seed data:** `corepack pnpm --filter webapp run db:seed:webhooks` (append `-- <n>` for deliveries per endpoint).
- **Must-set env for data to show:** `WEBHOOK_DELIVERIES_REPLICATION_ENABLED=1` and `WEBHOOK_DELIVERIES_REPLICATION_CLICKHOUSE_URL=http://default:password@localhost:8123`.
- **Login:** `local@trigger.dev`, magic link auto-verifies in dev.
- **Feature docs:** `docs/webhooks/` (overview, sources, connect, deliveries, channels, human-in-the-loop). Read `overview.mdx` and `deliveries.mdx` first for the mental model behind the screens.
- **PR:** https://github.com/triggerdotdev/trigger.dev/pull/4344

---

## 10. Mental model in one paragraph

A user writes a `webhook()` in their project. On deploy (or `trigger dev`) that handler gets one or more hosted endpoints, each with a signing secret. A provider POSTs to the endpoint's URL; the engine verifies the signature, optionally filters, records a `WebhookDelivery`, and triggers the routed task run. The dashboard reads those deliveries: the list orders them out of ClickHouse and hydrates the rest from Postgres, the detail page reads Postgres directly (it holds the only copy of the event payload and headers). Everything you design sits on top of that delivery record and the endpoint that produced it.
