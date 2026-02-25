# Guidance for Coding Agents

This repository is a pnpm monorepo managed with Turbo. It contains multiple apps and packages that make up the Trigger.dev platform and SDK.

## Repository layout
- `apps/webapp` – Remix application that serves as the main API and dashboard.
- `apps/supervisor` – Node application for executing built tasks.
- `packages/*` – Published packages such as `@trigger.dev/sdk`, the CLI (`trigger.dev`), and shared libraries.
- `internal-packages/*` – Internal-only packages used by the webapp and other apps.
- `references/*` – Example projects for manual testing and development of new features.
- `ai/references` – Contains additional documentation including an overview (`repo.md`) and testing guidelines (`tests.md`).

See `ai/references/repo.md` for a more complete explanation of the workspaces.

## Development setup
1. Install dependencies with `pnpm i` (pnpm `10.23.0` and Node.js `20.20.0` are required).
2. Copy `.env.example` to `.env` and generate a random 16 byte hex string for `ENCRYPTION_KEY` (`openssl rand -hex 16`). Update other secrets if needed.
3. Start the local services with Docker:
   ```bash
   pnpm run docker
   ```
4. Run database migrations:
   ```bash
   pnpm run db:migrate
   ```
5. Build the webapp, CLI and SDK packages:
   ```bash
   pnpm run build --filter webapp && pnpm run build --filter trigger.dev && pnpm run build --filter @trigger.dev/sdk
   ```
6. Launch the development server:
   ```bash
   pnpm run dev --filter webapp
   ```
   The webapp runs on <http://localhost:3030>.

For full setup instructions see `CONTRIBUTING.md`.

## Running tests
- Unit tests use **vitest**. Run all tests:
  ```bash
  pnpm run test
  ```
- Run tests for a specific workspace (example for `webapp`):
  ```bash
  pnpm run test --filter webapp
  ```
- Prefer running a single test file from within its directory:
  ```bash
  cd apps/webapp
  pnpm run test ./src/components/Button.test.ts
  ```
  If packages in that workspace need to be built first, run `pnpm run build --filter webapp`.

Refer to `ai/references/tests.md` for details on writing tests. Tests should avoid mocks or stubs and use the helpers from `@internal/testcontainers` when Redis or Postgres are needed.

## Coding style
- Formatting is enforced using Prettier. Run `pnpm run format` before committing.
- Follow the existing project conventions. Test files live beside the files under test and use descriptive `describe` and `it` blocks.
- Do not commit directly to the `main` branch. All changes should be made in a separate branch and go through a pull request.

## Additional docs
- The root `README.md` describes Trigger.dev and links to documentation.
- The `docs` workspace contains our documentation site, which can be run locally with:
  ```bash
  pnpm run dev --filter docs
  ```
- `references/README.md` explains how to create new reference projects for manual testing.

## Cursor Cloud specific instructions

### Docker services

Docker must be started before any service or test that needs PostgreSQL, Redis, ElectricSQL, or ClickHouse. Run `pnpm run docker` from the repo root. The Docker daemon itself requires `sudo dockerd` (run as a background process) and `sudo chmod 666 /var/run/docker.sock` in the Cloud VM environment. Docker-in-Docker uses `fuse-overlayfs` storage driver and `iptables-legacy`.

### Startup sequence (after dependency install)

1. `pnpm run docker` — starts PostgreSQL (5432), Redis (6379), Electric (3060), ClickHouse (8123).
2. `pnpm run db:migrate` — applies Prisma migrations.
3. `pnpm run build --filter webapp && pnpm run build --filter trigger.dev && pnpm run build --filter @trigger.dev/sdk` — builds essential packages.
4. `pnpm run dev --filter webapp` — starts the webapp on port 3030.

### Seeding

Run `pnpm run db:seed` from `apps/webapp` directly (not the root turbo command) to avoid build failures in optional reference projects. The seed creates a local user (`local@trigger.dev`) and reference projects including `hello-world`. This can take several minutes with no visible output due to buffering.

### Login in dev mode

Navigate to `http://localhost:3030`, click "Continue with Email", enter `local@trigger.dev`. The magic link auto-logs you in during local development (no real email required).

### Tests

- `@trigger.dev/core` tests are fast unit tests (run via `cd packages/core && pnpm run test --run`).
- `apps/webapp` tests include testcontainer-based integration tests that start PostgreSQL/Redis containers and can take 10+ minutes. For quick verification, run specific test files rather than the full suite.
- Always pass `--run` to vitest to avoid watch mode.

### Lint

Run `pnpm run lint --filter webapp` to lint the webapp. Warnings are expected (572 as of this writing); zero errors is the target.

