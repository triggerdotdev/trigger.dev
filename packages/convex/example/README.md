# Convex × Trigger.dev: prompt-driven image editing

A small demo by Trigger.dev: choose one of ten bundled photographs, describe a modification, and get a private, downloadable edited image.

**Public app:** https://ardent-rabbit-965.convex.site

## Current state

Backend, frontend, and Trigger tasks are deployed, and **image editing is enabled**. All Trigger.dev dependencies are pinned to `4.8.3` from npmjs, including `@trigger.dev/convex` and `@trigger.dev/react-hooks`.

A live Realtime verification completed the prepare → model edit → parallel exports workflow in **26.2 seconds**, streamed real phase metadata, requested authoritative Convex synchronization on completion, and verified all three private AVIF downloads. Unauthorized token issuance, cross-session refresh, cross-run token reads, and unauthenticated image access were rejected. The readable task payload contained no worker credential. A separate browser run verified the React subscription, terminal refresh, and final image delivery.

`AI_GATEWAY_API_KEY` belongs only in Trigger environment variables, never Convex, Vite, source files, or the browser.

## Page flow

The page has three vertical steps: choose an image, describe the edit, and view/download the result. Only one source photo is shown; a native dialog offers the other photographs. Export settings, internal task details, and budget counters are deliberately not exposed as controls.

A fresh visit starts with an empty prompt and result. Old results appear only after an explicit submission or history selection, never merely because their inputs match. The current draft, selected job, and submission request ID are saved for this browser session. Refreshing restores the exact photo, prompt, and job; an owned active job is also recovered from Convex when local editor state is missing. The request ID finds accepted work even if the browser missed its submission response. Recovery does not automatically enqueue another generation.

Restored results are labeled, and **New edit** clears the prompt/result while retaining the selected photo. Every disabled Submit state explains its reason. Selecting a previous edit restores its inputs. The page caches all generated variants privately, while showing just the primary image.

During work, one progress bar and three labels, **Prepare → Edit → Finish**, show actual workflow progress. There are no elapsed-time estimates or artificial progress increments. Convex still controls job completion and when verified results become visible.

## Actual Trigger workflow

The parent task `convex-edit-image` orchestrates:

1. **Prepare** (`convex-image-prepare`): load the selected bundled JPEG, strip metadata, and downsize to at most 1024 pixels per side.
2. **Edit** (`convex-image-model-edit`): send the photo and prompt to `meta/muse-image-1.0` through Vercel AI Gateway. Request exactly one image, with no automatic paid retries. Normalize the result to a bounded PNG.
3. **Export** (`convex-image-export`): fan out three child tasks concurrently, creating 1024 × 768, 800 × 600, and 400 × 400 AVIF versions using Sharp.
4. **Finish**: the parent collects successful exports. The component's terminal callback verifies the files, publishes safe metadata, and releases the admission lock.

Child tasks have deterministic job-specific idempotency keys. Every task has one attempt. A failed export does not rerun the image model automatically. There are no fake timers or artificial delays.

Convex transactionally admits the request and enqueues the Trigger component operation. For the selected active job, the browser uses `useRealtimeRun` with an ownership-authorized, exact-run token. Parent metadata reports each real phase; export children set idempotent completion flags. A terminal Realtime event invokes the ownership-checked `jobs.refresh` mutation, which calls the component’s `trigger.refresh()` API. It never forwards browser-provided status or output.

The component still polls Trigger every 15–60 seconds as recovery when browsers close or Realtime is unavailable. Registered artifacts also update Convex reactively. Progress is held at or below 95 until the completion callback verifies all files.

## Privacy and retention

- Each browser creates a cryptographically random 256-bit session capability. The server stores only its hash and scopes every job query to it.
- No shared gallery, public result query, or cross-user prompt cache.
- Images are served through an authenticated HTTP action, not public Convex storage URLs. Downloads require the browser's capability in an Authorization header. Tokens never go in image URLs.
- Trigger workers derive a job-scoped HMAC capability from `DEMO_ARTIFACT_SECRET`, configured only in Trigger and Convex server environments. No worker capability or shared secret appears in a task payload, metadata, or output. Browsers cannot upload artifacts or read intermediate files.
- Browser Realtime tokens authorize only the owned parent run, expire within ten minutes or job expiry, and remain in memory. Realtime omits payload/output columns, but this is not REST protection: the task payload must still be credential-free. Legacy jobs created before this migration cannot receive Realtime tokens.
- Task payloads and outputs contain references/metadata, not image bytes. Provider errors are sanitized to avoid recording image bodies in task errors. Prompt/task metadata is still available to trusted operators in private dashboards; this is not end-to-end encryption.
- The browser fetches final images as Blobs, previews them with object URLs, and keeps up to 20 jobs in session-scoped IndexedDB. Server URLs are not persisted in the local cache.
- Normal server files and job records expire one hour after admission. Intermediate files are removed on completion, and failed jobs have their registered files removed immediately. An hourly indexed sweep collects unregistered files left by process interruption, normally within two hours of upload.
- Root Convex storage is dedicated to this demo's artifacts. Static hosting uses isolated component storage. Scope the collector before introducing unrelated root-storage files.

Losing the browser session key loses access to pending remote jobs. Clearing local history does not erase the session key or immediately erase unexpired remote jobs. Browser storage can be evicted; downloads are the reliable way to retain files permanently. If IndexedDB is unavailable, current-page download links still work.

The image provider receives the selected bundled image and prompt. There are no visitor uploads or arbitrary input URLs.

## Spending and abuse limits

- Fixed model, exactly one generated image, and prompts capped at 500 characters.
- **500 lifetime admitted edits and 50 per UTC day**, enforced atomically before enqueueing. Counters persist across deployments and browser sessions.
- At the catalog's current $0.01/image rate, 500 generations is approximately **$5 in model charges**, excluding compute, storage, and traffic. These are admission limits, not a guarantee against future provider price changes.
- One outstanding job globally, a shared 20-second cooldown, five-minute task queue TTLs, and bounded execution durations.
- No automatic retries at either the Trigger task or AI SDK level. Failed jobs still consume their reserved slot, including definite pre-model failures. No automatic refunds on ambiguous failures.
- Fixed image inputs, pixel limits, bounded streamed artifact uploads, and no user-selected model/provider/size/count.
- `DEMO_ENABLED` is an operator kill switch. The manual deployment procedure pauses new work until deployment and hosting checks finish.
- Optional Turnstile is implemented. Set both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` in Convex to require a successful challenge with the deployment's hostname. A partially configured pair fails closed. Without these keys, spending caps still apply but CAPTCHA is not active.

These measures bound admitted image-generation work. They are not DDoS protection for public Convex endpoints. Use additional traffic controls before broad promotion.

## Setup and local development

This is a standalone, private pnpm workspace under `packages/convex/example`. Its dependencies, tests, assets, and build output are excluded from the `@trigger.dev/convex` package build and npm tarball. Run its commands from this directory, not the monorepo root.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev
corepack pnpm dev:convex
```

Without `VITE_CONVEX_URL`, the page is an honest read-only preview.

Current development deployment: `chris-arderne:tiny-worlds:dev/demo`, https://ardent-rabbit-965.convex.cloud. The historical Convex project name is unchanged. [Convex dashboard](https://dashboard.convex.dev/d/ardent-rabbit-965).

Trigger project: `convex-image-processing`, reference `proj_wcwcgcodbajkuocrovpq`. CLI profile **test**, environment **prod on test cloud**, not production cloud. [Trigger dashboard](https://test-cloud.trigger.dev/projects/v3/proj_wcwcgcodbajkuocrovpq).

Use Node.js 24 and pnpm 10.33.2. Authenticate the Convex CLI for the selected deployment and the Trigger CLI's `test` profile for test cloud. Ensure `.env.local` contains the selected deployment's `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` (see `.env.example`). Add `AI_GATEWAY_API_KEY` to the Trigger environment above before deploying tasks.

`configure` safely resolves the project's Trigger credentials from the CLI profile, creates or reuses the server-only artifact secret, and injects Convex configuration over stdin without printing secret values. Run it before the first task deployment so worker authentication is configured. Omit `--enable` to keep new work paused. For a different Trigger project, deliberately update the config and operator helper.

Follow the manual deployment steps below. The helper and `deploy:trigger` command target the existing test-cloud project; for another project, update `trigger.config.ts` and `scripts/cloud.ts` first.

Disable new work with:

```sh
corepack pnpm exec convex env set DEMO_ENABLED false
```

If component synchronization pauses, restore credentials and invoke the authenticated internal `jobs:resume` mutation with the job ID. Visitors cannot invoke it.

## Manual deployment

There is no demo CI or automatic deployment. Run these commands from `packages/convex/example`; no GitHub environments or repository secrets are required. They update the existing demo's selected **development** Convex deployment and its hosted frontend.

Install dependencies, check the example, pause new edits, and configure server credentials before deploying:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test
node scripts/cloud.ts configure
corepack pnpm exec convex dev --once --typecheck enable
corepack pnpm deploy:trigger --local-bundle
node scripts/cloud.ts status
```

Confirm the Trigger status is `DEPLOYED` before continuing. Then build/upload the frontend and check its public assets:

```sh
corepack pnpm upload:site
node scripts/verify-hosting.ts
```

`upload:site` runs the frontend build. Once deployment and hosting checks pass, explicitly enable new edits and check readiness without creating a generation:

```sh
node scripts/cloud.ts configure --enable
node scripts/verify.ts
```

Optionally run one paid end-to-end verification:

```sh
node scripts/verify.ts --launch --realtime
```

`--realtime` checks scoped token access, consumes live run updates, and requests a Convex refresh on the terminal frame. `--launch` explicitly spends one generation. The stable operator session/request is reused while the server job exists. If Turnstile is configured, use the browser for live generation; the CLI does not bypass the challenge.

`verify.ts` without `--launch` checks readiness and hosted samples without creating a model job. With an existing verification job it checks that job and authenticated downloads. Tests cover ownership of token issuance and refresh, job-scoped worker authentication, Realtime progress identity/clamping, cross-session isolation, authenticated file delivery/expiry, orphan cleanup, limits/deduplication, invalid result handling, native AVIF decoding, and bounded model-call configuration.

Live browser recovery QA submitted a Coast edit with Enter, refreshed mid-generation, left the page entirely for 35 seconds, and returned to the same job and verified result. Draft restoration, Shift+Enter, New edit/reset persistence, and explicit history selection were also checked without additional paid work.

Convex does not currently support renaming the generated `*.convex.site` subdomain ([feature request](https://ship.convex.dev/requests/js7ch5fteyhskr871g4w9ce5n58e1zh7)). An owned [custom domain](https://docs.convex.dev/production/custom-domains) requires Convex Pro and DNS configuration. Changing origins also creates a separate browser session/history unless a migration is provided.

`upload:site` updates the selected development frontend. `deploy:site` targets the default production deployment and deploys backend plus frontend. Do not confuse them.

The ten frozen JPEGs in `public/samples` come from Unsplash; source URLs are in `shared/catalog.ts`. See the [Unsplash license](https://unsplash.com/license). `node scripts/download-samples.ts` refreshes and bounds them to 1600 pixels per side; `--resize-only` normalizes existing local files without fetching again.

The example source lives alongside the component in `packages/convex/example` and syncs with the public repository. It is not included in published package bundles.
