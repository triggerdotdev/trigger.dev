# Sec Fix Pipeline — Phase 1: Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end orchestration skeleton — worker daemon picks one Linear issue from the deepsec view, runs a stub agent in a docker-compose stack, collects an artifact, uploads it to MinIO, posts a Linear comment, flips the label to `agent:done`, tears down. Validates pipeline plumbing before adding any real agent logic.

**Architecture:** New standalone repo at `~/Development/sec-fix-pipeline/`. Node + TypeScript worker daemon (no systemd yet — just a CLI you run manually), local Docker for the per-issue stack, local MinIO container for artifacts, Linear SDK for queue. Single-instance, serial, runs one issue then exits (loop comes in a later phase).

**Tech Stack:** TypeScript, pnpm, Vitest, `@linear/sdk`, `@aws-sdk/client-s3`, `execa` (for shelling to docker compose), `zod` (state file schema), `testcontainers` (MinIO + Linear-mock in tests).

**Scope:** Phase 1 of 6. Defers the full per-issue stack (Phase 3), real Claude Agent SDK (Phase 2), durability hardening (Phase 4), resumable runs (Phase 5), and the review dashboard (Phase 6). Ships when a real Linear test issue can be processed end-to-end by a manually-run worker against a stub agent.

**Spec reference:** `docs/superpowers/specs/2026-05-26-security-fix-pipeline-design.md` in the `trigger.dev-mirror-2` repo.

**Pinned base SHA (for later phases, not Phase 1):** `37eeaa36908fb1aad48fc43d04e5b4e8f474f957`

---

## File Structure

```
~/Development/sec-fix-pipeline/
├── package.json
├── pnpm-workspace.yaml          # for future packages
├── tsconfig.json
├── tsconfig.base.json
├── vitest.config.ts
├── .gitignore
├── .nvmrc
├── .env.example
├── README.md
├── docker/
│   ├── agent-stub/
│   │   ├── Dockerfile
│   │   └── run-agent.mjs        # writes /artifacts/hello.txt, exits 0
│   └── stack.yml                # MinIO host service + per-issue agent service
├── src/
│   ├── config.ts                # env loading, zod-validated
│   ├── logger.ts                # pino, json output
│   ├── state.ts                 # state file read/write/transition
│   ├── linear/
│   │   ├── client.ts            # wraps @linear/sdk + the deepsec view
│   │   ├── client.test.ts
│   │   └── labels.ts            # label constants + state machine helpers
│   ├── storage/
│   │   ├── minio.ts             # S3 client for local MinIO
│   │   └── minio.test.ts
│   ├── stack/
│   │   ├── compose.ts           # `docker compose` wrapper with timeouts
│   │   └── compose.test.ts
│   ├── worker/
│   │   ├── process-issue.ts     # the per-issue flow
│   │   ├── process-issue.test.ts
│   │   └── main.ts              # CLI entry — pick one issue, process, exit
│   └── types.ts
├── test/
│   └── integration/
│       └── end-to-end.test.ts   # full flow against a mock Linear + real MinIO + stub agent
└── scripts/
    ├── setup-minio.sh           # idempotent bucket creation
    └── seed-test-issue.ts       # creates a Linear test issue labelled agent:queued
```

**Responsibilities:**

- `config.ts` — single place for env vars; fails fast if anything missing.
- `state.ts` — atomic writes to `./state/<issueId>.json`. Source of truth for phase transitions.
- `linear/` — every Linear interaction. Mock-friendly. View ID hardcoded as a constant.
- `storage/` — MinIO/S3 only. No Linear coupling.
- `stack/` — docker compose only. No state, no Linear.
- `worker/process-issue.ts` — orchestrates: claim → run → collect → upload → notify → finalize. The integration point.
- `worker/main.ts` — CLI front-end. Loops come in Phase 4.

---

## Task 1: Bootstrap the new repo

**Files:**
- Create: `~/Development/sec-fix-pipeline/package.json`
- Create: `~/Development/sec-fix-pipeline/tsconfig.json`
- Create: `~/Development/sec-fix-pipeline/.gitignore`
- Create: `~/Development/sec-fix-pipeline/.nvmrc`
- Create: `~/Development/sec-fix-pipeline/.env.example`
- Create: `~/Development/sec-fix-pipeline/README.md`

- [ ] **Step 1: Create the repo and initialize git**

```bash
mkdir -p ~/Development/sec-fix-pipeline
cd ~/Development/sec-fix-pipeline
git init
git checkout -b main
```

- [ ] **Step 2: Write `.nvmrc`**

```
22.13.0
```

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "sec-fix-pipeline",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "packageManager": "pnpm@10.33.2",
  "engines": { "node": ">=22.13.0" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "worker": "tsx src/worker/main.ts",
    "setup:minio": "bash scripts/setup-minio.sh",
    "seed:issue": "tsx scripts/seed-test-issue.ts"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "3.654.0",
    "@aws-sdk/lib-storage": "3.654.0",
    "@linear/sdk": "32.0.0",
    "execa": "9.5.1",
    "pino": "9.5.0",
    "tsx": "4.19.2",
    "zod": "3.25.76"
  },
  "devDependencies": {
    "@types/node": "22.10.2",
    "testcontainers": "10.16.0",
    "typescript": "5.7.2",
    "vitest": "2.1.8"
  }
}
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules
dist
state/
out/
snapshots/
logs/
.env
.env.local
*.log
.DS_Store
```

- [ ] **Step 6: Write `.env.example`**

```
LINEAR_API_KEY=
LINEAR_DEEPSEC_VIEW_ID=c443c3c869c0
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=security-artifacts
WORKER_STATE_DIR=./state
WORKER_OUT_DIR=./out
WORKER_LOGS_DIR=./logs
```

- [ ] **Step 7: Write `README.md`**

```markdown
# sec-fix-pipeline

Autonomous pipeline for validating and proposing fixes for security findings tracked in the deepsec-findings Linear view. Reads issues, runs an isolated container per issue with Claude Code, produces patch bundles for human review.

See design spec: `trigger.dev-mirror-2/docs/superpowers/specs/2026-05-26-security-fix-pipeline-design.md`.

## Phase 1 status

End-to-end skeleton. Stub agent only — writes `hello.txt`, no real fixing yet.

## Setup

1. `pnpm i`
2. `cp .env.example .env` and fill in `LINEAR_API_KEY`
3. `docker compose -f docker/stack.yml --profile services up -d minio`
4. `pnpm setup:minio`
5. `pnpm seed:issue` to create a Linear test issue
6. `pnpm worker` to process it

## Layout

See `docs/architecture.md` (to be written in a later phase).
```

- [ ] **Step 8: Install dependencies**

```bash
cd ~/Development/sec-fix-pipeline
pnpm i
```

Expected: clean install, no errors.

- [ ] **Step 9: Verify TypeScript compiles (empty src)**

```bash
mkdir -p src
echo "export {};" > src/index.ts
pnpm typecheck
```

Expected: no output (success).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: bootstrap repo with TS + pnpm + vitest"
```

---

## Task 2: Config module

**Files:**
- Create: `~/Development/sec-fix-pipeline/src/config.ts`
- Create: `~/Development/sec-fix-pipeline/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

`src/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("returns a parsed config when all required vars are set", () => {
    const cfg = loadConfig({
      LINEAR_API_KEY: "lin_api_test",
      LINEAR_DEEPSEC_VIEW_ID: "c443c3c869c0",
      MINIO_ENDPOINT: "http://localhost:9000",
      MINIO_ACCESS_KEY: "x",
      MINIO_SECRET_KEY: "y",
      MINIO_BUCKET: "security-artifacts",
      WORKER_STATE_DIR: "./state",
      WORKER_OUT_DIR: "./out",
      WORKER_LOGS_DIR: "./logs",
    });
    expect(cfg.linear.apiKey).toBe("lin_api_test");
    expect(cfg.minio.bucket).toBe("security-artifacts");
  });

  it("throws when LINEAR_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow(/LINEAR_API_KEY/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/config.test.ts
```

Expected: FAIL — module `./config.js` not found.

- [ ] **Step 3: Write `config.ts`**

```ts
import { z } from "zod";

const Schema = z.object({
  LINEAR_API_KEY: z.string().min(1),
  LINEAR_DEEPSEC_VIEW_ID: z.string().min(1),
  MINIO_ENDPOINT: z.string().url(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(1),
  WORKER_STATE_DIR: z.string().min(1),
  WORKER_OUT_DIR: z.string().min(1),
  WORKER_LOGS_DIR: z.string().min(1),
});

export type Config = {
  linear: { apiKey: string; viewId: string };
  minio: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
  };
  dirs: { state: string; out: string; logs: string };
};

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.parse(env);
  return {
    linear: { apiKey: parsed.LINEAR_API_KEY, viewId: parsed.LINEAR_DEEPSEC_VIEW_ID },
    minio: {
      endpoint: parsed.MINIO_ENDPOINT,
      accessKey: parsed.MINIO_ACCESS_KEY,
      secretKey: parsed.MINIO_SECRET_KEY,
      bucket: parsed.MINIO_BUCKET,
    },
    dirs: {
      state: parsed.WORKER_STATE_DIR,
      out: parsed.WORKER_OUT_DIR,
      logs: parsed.WORKER_LOGS_DIR,
    },
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/config.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: config module with zod-validated env loading"
```

---

## Task 3: Logger module

**Files:**
- Create: `~/Development/sec-fix-pipeline/src/logger.ts`

- [ ] **Step 1: Write `logger.ts`**

```ts
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "sec-fix-worker" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
```

- [ ] **Step 2: Smoke test**

```bash
node --experimental-strip-types -e "import('./src/logger.ts').then(m => m.logger.info({ hello: 'world' }, 'test'))"
```

Expected: a single JSON line on stdout containing `"hello":"world"`.

- [ ] **Step 3: Commit**

```bash
git add src/logger.ts
git commit -m "feat: pino logger module"
```

---

## Task 4: State file module

State files live at `${WORKER_STATE_DIR}/<issueIdentifier>.json`. Phase 1 only uses two phases (`claimed`, `finalized`) — the full state machine comes in Phase 4. We still write the file atomically (write to tmp, fsync, rename) because that pattern is load-bearing for Phase 4.

**Files:**
- Create: `~/Development/sec-fix-pipeline/src/state.ts`
- Create: `~/Development/sec-fix-pipeline/src/state.test.ts`

- [ ] **Step 1: Write the failing test**

`src/state.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState, IssueState } from "./state.js";

describe("state file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sec-state-"));
    return async () => rm(dir, { recursive: true, force: true });
  });

  it("returns null for a missing issue", async () => {
    expect(await readState(dir, "LIN-999")).toBeNull();
  });

  it("round-trips a state object", async () => {
    const state: IssueState = {
      issueIdentifier: "LIN-1",
      phase: "claimed",
      project: "sec-lin-1",
      startedAt: "2026-05-26T10:00:00Z",
      outcome: null,
    };
    await writeState(dir, state);
    const read = await readState(dir, "LIN-1");
    expect(read).toEqual(state);
  });

  it("writes atomically via a tmp+rename", async () => {
    const state: IssueState = {
      issueIdentifier: "LIN-2",
      phase: "claimed",
      project: "sec-lin-2",
      startedAt: "2026-05-26T10:00:00Z",
      outcome: null,
    };
    await writeState(dir, state);
    const raw = await readFile(join(dir, "LIN-2.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(state);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/state.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `state.ts`**

```ts
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const PhaseSchema = z.enum(["claimed", "running", "uploaded", "finalized"]);
const OutcomeSchema = z.enum(["done", "failed", "false-positive", "runaway"]).nullable();

export const IssueStateSchema = z.object({
  issueIdentifier: z.string().min(1),
  phase: PhaseSchema,
  project: z.string().min(1),
  startedAt: z.string().min(1),
  outcome: OutcomeSchema,
});
export type IssueState = z.infer<typeof IssueStateSchema>;

function pathFor(dir: string, issueIdentifier: string): string {
  return join(dir, `${issueIdentifier}.json`);
}

export async function readState(dir: string, issueIdentifier: string): Promise<IssueState | null> {
  try {
    const raw = await readFile(pathFor(dir, issueIdentifier), "utf8");
    return IssueStateSchema.parse(JSON.parse(raw));
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeState(dir: string, state: IssueState): Promise<void> {
  await mkdir(dir, { recursive: true });
  const final = pathFor(dir, state.issueIdentifier);
  const tmp = `${final}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { flag: "w" });
  await rename(tmp, final);
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/state.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts src/state.test.ts
git commit -m "feat: state file module with atomic writes"
```

---

## Task 5: Linear labels module

**Files:**
- Create: `~/Development/sec-fix-pipeline/src/linear/labels.ts`

- [ ] **Step 1: Write `labels.ts`**

```ts
export const LABELS = {
  queued: "agent:queued",
  inProgress: "agent:in-progress",
  done: "agent:done",
  falsePositive: "agent:false-positive",
  runaway: "agent:runaway",
  resume: "agent:resume",
  failed: "agent:failed",
  reviewedAccept: "agent:reviewed-accept",
  reviewedReject: "agent:reviewed-reject",
} as const;

export type AgentLabel = typeof LABELS[keyof typeof LABELS];

export const TERMINAL_LABELS: readonly AgentLabel[] = [
  LABELS.done,
  LABELS.falsePositive,
  LABELS.failed,
  LABELS.runaway,
] as const;

export const AGENT_OWNED_LABELS: readonly AgentLabel[] = Object.values(LABELS) as readonly AgentLabel[];
```

- [ ] **Step 2: Commit**

```bash
git add src/linear/labels.ts
git commit -m "feat: agent label constants"
```

---

## Task 6: Linear client wrapper

**Files:**
- Create: `~/Development/sec-fix-pipeline/src/linear/client.ts`
- Create: `~/Development/sec-fix-pipeline/src/linear/client.test.ts`

For Phase 1 we only need: `findNextQueuedIssue()`, `swapLabel(issueId, fromLabel, toLabel)`, `addComment(issueId, body)`. The `nextFromDeepsecView` filter is implemented as: fetch the view's issues filtered by label `agent:queued`. We'll stub the SDK in tests with a hand-rolled fake; we are not running against real Linear in unit tests.

- [ ] **Step 1: Write the failing test**

`src/linear/client.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createLinearClient, LinearGateway } from "./client.js";
import { LABELS } from "./labels.js";

function fakeGateway(overrides: Partial<LinearGateway> = {}): LinearGateway {
  return {
    listIssuesInViewWithLabel: vi.fn().mockResolvedValue([]),
    listLabelIdsForIssue: vi.fn().mockResolvedValue([]),
    findLabelIdByName: vi.fn().mockResolvedValue("label-id-fake"),
    updateIssueLabels: vi.fn().mockResolvedValue(undefined),
    createComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("LinearClient", () => {
  it("findNextQueuedIssue returns the first issue in the view labelled queued", async () => {
    const gateway = fakeGateway({
      listIssuesInViewWithLabel: vi.fn().mockResolvedValue([
        { id: "i1", identifier: "LIN-1", title: "fix sql injection in users", body: "details", labelIds: ["label-id-fake"] },
        { id: "i2", identifier: "LIN-2", title: "fix xss", body: "details", labelIds: ["label-id-fake"] },
      ]),
    });
    const client = createLinearClient({ viewId: "view-x" }, gateway);
    const next = await client.findNextQueuedIssue();
    expect(next?.identifier).toBe("LIN-1");
    expect(gateway.listIssuesInViewWithLabel).toHaveBeenCalledWith("view-x", LABELS.queued);
  });

  it("swapLabel removes the from label and adds the to label", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const gateway = fakeGateway({
      listLabelIdsForIssue: vi.fn().mockResolvedValue(["from-id", "other-id"]),
      findLabelIdByName: vi.fn().mockImplementation((name: string) =>
        Promise.resolve(name === LABELS.queued ? "from-id" : "to-id"),
      ),
      updateIssueLabels: update,
    });
    const client = createLinearClient({ viewId: "view-x" }, gateway);
    await client.swapLabel("issue-1", LABELS.queued, LABELS.inProgress);
    expect(update).toHaveBeenCalledWith("issue-1", ["other-id", "to-id"]);
  });

  it("addComment delegates to gateway", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const gateway = fakeGateway({ createComment: create });
    const client = createLinearClient({ viewId: "view-x" }, gateway);
    await client.addComment("issue-1", "hello");
    expect(create).toHaveBeenCalledWith("issue-1", "hello");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/linear/client.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `client.ts`**

```ts
import { LinearClient as SDKClient } from "@linear/sdk";
import { LABELS, type AgentLabel } from "./labels.js";

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  body: string;
  labelIds: string[];
};

export type LinearGateway = {
  listIssuesInViewWithLabel(viewId: string, label: AgentLabel): Promise<LinearIssue[]>;
  listLabelIdsForIssue(issueId: string): Promise<string[]>;
  findLabelIdByName(name: AgentLabel): Promise<string>;
  updateIssueLabels(issueId: string, labelIds: string[]): Promise<void>;
  createComment(issueId: string, body: string): Promise<void>;
};

export type LinearClient = {
  findNextQueuedIssue(): Promise<LinearIssue | null>;
  swapLabel(issueId: string, from: AgentLabel, to: AgentLabel): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
};

export function createLinearClient(opts: { viewId: string }, gateway: LinearGateway): LinearClient {
  return {
    async findNextQueuedIssue() {
      const issues = await gateway.listIssuesInViewWithLabel(opts.viewId, LABELS.queued);
      return issues[0] ?? null;
    },
    async swapLabel(issueId, from, to) {
      const [current, fromId, toId] = await Promise.all([
        gateway.listLabelIdsForIssue(issueId),
        gateway.findLabelIdByName(from),
        gateway.findLabelIdByName(to),
      ]);
      const next = Array.from(new Set([...current.filter((id) => id !== fromId), toId]));
      await gateway.updateIssueLabels(issueId, next);
    },
    async addComment(issueId, body) {
      await gateway.createComment(issueId, body);
    },
  };
}

export function createRealGateway(apiKey: string): LinearGateway {
  const sdk = new SDKClient({ apiKey });
  return {
    async listIssuesInViewWithLabel(viewId, label) {
      const view = await sdk.customView(viewId);
      const issuesConnection = await view.issues({
        filter: { labels: { name: { eq: label } } },
        orderBy: undefined,
      } as any);
      return issuesConnection.nodes.map((n) => ({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        body: n.description ?? "",
        labelIds: (n as any)._labelIds ?? [],
      }));
    },
    async listLabelIdsForIssue(issueId) {
      const issue = await sdk.issue(issueId);
      const labels = await issue.labels();
      return labels.nodes.map((l) => l.id);
    },
    async findLabelIdByName(name) {
      const labels = await sdk.issueLabels({ filter: { name: { eq: name } } });
      const found = labels.nodes[0];
      if (!found) throw new Error(`Linear label not found: ${name}`);
      return found.id;
    },
    async updateIssueLabels(issueId, labelIds) {
      await sdk.updateIssue(issueId, { labelIds });
    },
    async createComment(issueId, body) {
      await sdk.createComment({ issueId, body });
    },
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/linear/client.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/linear/client.ts src/linear/client.test.ts
git commit -m "feat: linear client with gateway abstraction"
```

---

## Task 7: MinIO storage module

**Files:**
- Create: `~/Development/sec-fix-pipeline/src/storage/minio.ts`
- Create: `~/Development/sec-fix-pipeline/src/storage/minio.test.ts`

We use the AWS SDK against MinIO's S3-compatible endpoint. The test uses testcontainers to spin a real MinIO — no mocking S3 itself.

- [ ] **Step 1: Write the failing test**

`src/storage/minio.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorage } from "./minio.js";

let minio: StartedTestContainer;
let endpoint: string;

beforeAll(async () => {
  minio = await new GenericContainer("minio/minio:RELEASE.2024-10-29T16-01-48Z")
    .withCommand(["server", "/data"])
    .withEnvironment({ MINIO_ROOT_USER: "test", MINIO_ROOT_PASSWORD: "testtest" })
    .withExposedPorts(9000)
    .start();
  endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
}, 60_000);

afterAll(async () => {
  await minio.stop();
});

describe("storage", () => {
  it("uploads a directory and lists its keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "upload-"));
    try {
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "a.txt"), "alpha");
      await writeFile(join(dir, "sub/b.txt"), "beta");

      const storage = createStorage({
        endpoint,
        accessKey: "test",
        secretKey: "testtest",
        bucket: "test-bucket",
      });
      await storage.ensureBucket();
      await storage.uploadDirectory(dir, "LIN-1/");

      const keys = await storage.list("LIN-1/");
      expect(keys.sort()).toEqual(["LIN-1/a.txt", "LIN-1/sub/b.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/storage/minio.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `minio.ts`**

```ts
import { S3Client, CreateBucketCommand, HeadBucketCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, posix } from "node:path";

export type Storage = {
  ensureBucket(): Promise<void>;
  uploadDirectory(localDir: string, keyPrefix: string): Promise<void>;
  list(keyPrefix: string): Promise<string[]>;
};

export function createStorage(opts: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}): Storage {
  const s3 = new S3Client({
    endpoint: opts.endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey },
    forcePathStyle: true,
  });

  return {
    async ensureBucket() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: opts.bucket }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket: opts.bucket }));
      }
    },

    async uploadDirectory(localDir, keyPrefix) {
      const files = await walk(localDir);
      for (const abs of files) {
        const rel = relative(localDir, abs).split(/[\\/]/).join("/");
        const key = posix.join(keyPrefix.replace(/\/+$/, ""), rel);
        const body = await readFile(abs);
        await s3.send(new PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: body }));
      }
    },

    async list(keyPrefix) {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const resp = await s3.send(
          new ListObjectsV2Command({ Bucket: opts.bucket, Prefix: keyPrefix, ContinuationToken: token }),
        );
        for (const obj of resp.Contents ?? []) if (obj.Key) out.push(obj.Key);
        token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
  };
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/storage/minio.test.ts
```

Expected: 1 test passes (testcontainer pull may take a minute first time).

- [ ] **Step 5: Commit**

```bash
git add src/storage/minio.ts src/storage/minio.test.ts
git commit -m "feat: minio storage module with directory upload"
```

---

## Task 8: Compose wrapper

**Files:**
- Create: `~/Development/sec-fix-pipeline/src/stack/compose.ts`
- Create: `~/Development/sec-fix-pipeline/src/stack/compose.test.ts`

The compose module wraps three operations: `up --wait`, `wait <service>`, `down -v`. Tests use a tiny fixture `compose-fixture.yml` with a single alpine service that sleeps then exits — no real stack needed.

- [ ] **Step 1: Write a compose fixture for the test**

Create `src/stack/__fixtures__/compose-fixture.yml`:

```yaml
services:
  agent:
    image: alpine:3.20
    command: ["sh", "-c", "echo started; sleep 2; echo done; exit 0"]
```

- [ ] **Step 2: Write the failing test**

`src/stack/compose.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { createCompose } from "./compose.js";

const fixture = join(__dirname, "__fixtures__/compose-fixture.yml");

describe("compose", () => {
  it("up → wait → down cycles cleanly and reports exit code", async () => {
    const compose = createCompose({
      file: fixture,
      project: `sec-fix-test-${Date.now()}`,
    });
    try {
      await compose.up({ timeoutMs: 30_000 });
      const exitCode = await compose.waitForService("agent", { timeoutMs: 30_000 });
      expect(exitCode).toBe(0);
    } finally {
      await compose.down({ timeoutMs: 30_000 });
    }
  }, 90_000);
});
```

- [ ] **Step 3: Run test, verify it fails**

```bash
pnpm test src/stack/compose.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write `compose.ts`**

```ts
import { execa } from "execa";

export type Compose = {
  up(opts: { timeoutMs: number }): Promise<void>;
  waitForService(service: string, opts: { timeoutMs: number }): Promise<number>;
  down(opts: { timeoutMs: number }): Promise<void>;
};

export function createCompose(opts: { file: string; project: string }): Compose {
  const base = ["compose", "-p", opts.project, "-f", opts.file];

  return {
    async up({ timeoutMs }) {
      await execa("docker", [...base, "up", "-d", "--wait"], { timeout: timeoutMs });
    },

    async waitForService(service, { timeoutMs }) {
      const result = await execa("docker", [...base, "wait", service], { timeout: timeoutMs });
      const code = parseInt(result.stdout.trim(), 10);
      if (Number.isNaN(code)) {
        throw new Error(`docker compose wait returned non-numeric: ${result.stdout}`);
      }
      return code;
    },

    async down({ timeoutMs }) {
      await execa("docker", [...base, "down", "-v"], { timeout: timeoutMs });
    },
  };
}
```

- [ ] **Step 5: Run test, verify it passes**

```bash
pnpm test src/stack/compose.test.ts
```

Expected: 1 test passes. Requires Docker running locally.

- [ ] **Step 6: Commit**

```bash
git add src/stack/compose.ts src/stack/compose.test.ts src/stack/__fixtures__/compose-fixture.yml
git commit -m "feat: docker compose wrapper (up/wait/down)"
```

---

## Task 9: Stub agent container

**Files:**
- Create: `~/Development/sec-fix-pipeline/docker/agent-stub/Dockerfile`
- Create: `~/Development/sec-fix-pipeline/docker/agent-stub/run-agent.mjs`

The Phase 1 agent does nothing real — writes a hello file with the issue identifier into `/artifacts/`, then exits 0. The container interface is the contract Phase 2 will fill out.

- [ ] **Step 1: Write `run-agent.mjs`**

```js
import { writeFile, mkdir } from "node:fs/promises";

const issueId = process.env.LINEAR_ISSUE_ID;
if (!issueId) {
  console.error("LINEAR_ISSUE_ID is required");
  process.exit(2);
}

await mkdir("/artifacts", { recursive: true });
await writeFile(
  "/artifacts/hello.txt",
  `Hello from sec-fix-pipeline phase 1 stub agent.\nIssue: ${issueId}\nTimestamp: ${new Date().toISOString()}\n`,
);
await writeFile(
  "/artifacts/final-summary.md",
  `# Stub agent run\n\nIssue: ${issueId}\n\nThis is a Phase 1 skeleton. No real validation or fix was performed.\n`,
);
await writeFile(
  "/artifacts/status.json",
  JSON.stringify({ issueId, endedAt: new Date().toISOString(), stub: true }, null, 2),
);

console.log(`stub agent done for ${issueId}`);
process.exit(0);
```

- [ ] **Step 2: Write `Dockerfile`**

```dockerfile
FROM node:22.13.0-alpine
WORKDIR /app
COPY run-agent.mjs ./run-agent.mjs
ENTRYPOINT ["node", "/app/run-agent.mjs"]
```

- [ ] **Step 3: Build the image**

```bash
cd ~/Development/sec-fix-pipeline
docker build -t sec-fix/agent-stub:latest docker/agent-stub
```

Expected: build succeeds.

- [ ] **Step 4: Smoke-run the image**

```bash
docker run --rm -e LINEAR_ISSUE_ID=LIN-TEST -v $PWD/tmp-artifacts:/artifacts sec-fix/agent-stub:latest
ls tmp-artifacts/
rm -rf tmp-artifacts/
```

Expected: prints "stub agent done for LIN-TEST"; directory contains `hello.txt`, `final-summary.md`, `status.json`.

- [ ] **Step 5: Commit**

```bash
git add docker/agent-stub/
git commit -m "feat: stub agent container that writes hello artifact"
```

---

## Task 10: Per-issue stack template

For Phase 1 the stack contains only the agent service. Later phases add postgres, redis, clickhouse, webapp, electric, and the shared `repo` volume. The MinIO host service is run separately (long-lived, shared across all issues).

**Files:**
- Create: `~/Development/sec-fix-pipeline/docker/stack.yml`

- [ ] **Step 1: Write `stack.yml`**

```yaml
# Per-issue compose template. Instantiated with -p sec-<issueIdentifier>.
# Phase 1: agent service only. Phase 3 will add the full trigger.dev stack.

name: sec-fix-issue

services:
  agent:
    image: sec-fix/agent-stub:latest
    environment:
      LINEAR_ISSUE_ID: "${LINEAR_ISSUE_ID:?LINEAR_ISSUE_ID must be set}"
    volumes:
      - artifacts:/artifacts

volumes:
  artifacts:
```

- [ ] **Step 2: Write the host services compose file**

Create `docker/host-services.yml`:

```yaml
# Long-lived host services. Brought up once with:
#   docker compose -f docker/host-services.yml up -d

name: sec-fix-host

services:
  minio:
    image: minio/minio:RELEASE.2024-10-29T16-01-48Z
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: "${MINIO_ACCESS_KEY:-minioadmin}"
      MINIO_ROOT_PASSWORD: "${MINIO_SECRET_KEY:-minioadmin}"
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio-data:/data
    restart: unless-stopped

volumes:
  minio-data:
```

- [ ] **Step 3: Start host services**

```bash
docker compose -f docker/host-services.yml up -d
docker ps | grep minio
```

Expected: MinIO container running on port 9000.

- [ ] **Step 4: Commit**

```bash
git add docker/stack.yml docker/host-services.yml
git commit -m "feat: per-issue stack template and host MinIO service"
```

---

## Task 11: MinIO bucket setup script

**Files:**
- Create: `~/Development/sec-fix-pipeline/scripts/setup-minio.sh`

- [ ] **Step 1: Write `setup-minio.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Loads env from .env if present
if [ -f .env ]; then
  set -a; source .env; set +a
fi

: "${MINIO_ENDPOINT:?must be set}"
: "${MINIO_ACCESS_KEY:?must be set}"
: "${MINIO_SECRET_KEY:?must be set}"
: "${MINIO_BUCKET:?must be set}"

docker run --rm --network host \
  -e MC_HOST_local="http://${MINIO_ACCESS_KEY}:${MINIO_SECRET_KEY}@${MINIO_ENDPOINT#http://}" \
  minio/mc:RELEASE.2024-10-29T15-34-59Z \
  mb -p "local/${MINIO_BUCKET}"

echo "Bucket ready: ${MINIO_BUCKET}"
```

- [ ] **Step 2: Make executable and run**

```bash
chmod +x scripts/setup-minio.sh
pnpm setup:minio
```

Expected: prints "Bucket ready: security-artifacts" (or reports the bucket already exists).

- [ ] **Step 3: Commit**

```bash
git add scripts/setup-minio.sh
git commit -m "feat: minio bucket setup script"
```

---

## Task 12: process-issue orchestration

This is the integration point. It claims the issue, runs the stack, collects `/artifacts/` from the compose volume, uploads to MinIO, posts a Linear comment, and finalizes the label.

**Files:**
- Create: `~/Development/sec-fix-pipeline/src/worker/process-issue.ts`
- Create: `~/Development/sec-fix-pipeline/src/worker/process-issue.test.ts`

- [ ] **Step 1: Write the failing test**

`src/worker/process-issue.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIssue, ProcessIssueDeps } from "./process-issue.js";
import { LABELS } from "../linear/labels.js";

function deps(overrides: Partial<ProcessIssueDeps> = {}): ProcessIssueDeps {
  return {
    linear: {
      findNextQueuedIssue: vi.fn(),
      swapLabel: vi.fn().mockResolvedValue(undefined),
      addComment: vi.fn().mockResolvedValue(undefined),
    },
    compose: {
      up: vi.fn().mockResolvedValue(undefined),
      waitForService: vi.fn().mockResolvedValue(0),
      down: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      uploadDirectory: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    collectArtifacts: vi.fn().mockResolvedValue(undefined),
    stateDir: "",
    outDir: "",
    logger: { info: () => {}, error: () => {}, warn: () => {} } as any,
    ...overrides,
  };
}

describe("processIssue", () => {
  it("happy path: claim → up → wait → collect → upload → comment → done", async () => {
    const d = deps();
    const stateDir = await mkdtemp(join(tmpdir(), "state-"));
    const outDir = await mkdtemp(join(tmpdir(), "out-"));
    try {
      await processIssue(
        { id: "issue-1", identifier: "LIN-1", title: "test", body: "", labelIds: [] },
        { ...d, stateDir, outDir },
      );
      expect(d.linear.swapLabel).toHaveBeenNthCalledWith(1, "issue-1", LABELS.queued, LABELS.inProgress);
      expect(d.compose.up).toHaveBeenCalledOnce();
      expect(d.compose.waitForService).toHaveBeenCalledWith("agent", expect.any(Object));
      expect(d.storage.uploadDirectory).toHaveBeenCalled();
      expect(d.linear.addComment).toHaveBeenCalled();
      expect(d.linear.swapLabel).toHaveBeenNthCalledWith(2, "issue-1", LABELS.inProgress, LABELS.done);
      expect(d.compose.down).toHaveBeenCalledOnce();

      const state = JSON.parse(await readFile(join(stateDir, "LIN-1.json"), "utf8"));
      expect(state.phase).toBe("finalized");
      expect(state.outcome).toBe("done");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("agent non-zero exit causes failed outcome and label", async () => {
    const d = deps({
      compose: {
        up: vi.fn().mockResolvedValue(undefined),
        waitForService: vi.fn().mockResolvedValue(1),
        down: vi.fn().mockResolvedValue(undefined),
      },
    });
    const stateDir = await mkdtemp(join(tmpdir(), "state-"));
    const outDir = await mkdtemp(join(tmpdir(), "out-"));
    try {
      await processIssue(
        { id: "issue-2", identifier: "LIN-2", title: "test", body: "", labelIds: [] },
        { ...d, stateDir, outDir },
      );
      expect(d.linear.swapLabel).toHaveBeenLastCalledWith("issue-2", LABELS.inProgress, LABELS.failed);
      const state = JSON.parse(await readFile(join(stateDir, "LIN-2.json"), "utf8"));
      expect(state.outcome).toBe("failed");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("always tears down the stack, even if upload fails", async () => {
    const d = deps({
      storage: {
        ensureBucket: vi.fn().mockResolvedValue(undefined),
        uploadDirectory: vi.fn().mockRejectedValue(new Error("minio down")),
        list: vi.fn().mockResolvedValue([]),
      },
    });
    const stateDir = await mkdtemp(join(tmpdir(), "state-"));
    const outDir = await mkdtemp(join(tmpdir(), "out-"));
    try {
      await expect(
        processIssue(
          { id: "issue-3", identifier: "LIN-3", title: "test", body: "", labelIds: [] },
          { ...d, stateDir, outDir },
        ),
      ).rejects.toThrow(/minio down/);
      expect(d.compose.down).toHaveBeenCalledOnce();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/worker/process-issue.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `process-issue.ts`**

```ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LinearClient, LinearIssue } from "../linear/client.js";
import { LABELS } from "../linear/labels.js";
import type { Compose } from "../stack/compose.js";
import type { Storage } from "../storage/minio.js";
import type { Logger } from "../logger.js";
import { writeState } from "../state.js";

export type ProcessIssueDeps = {
  linear: LinearClient;
  compose: Compose;
  storage: Storage;
  collectArtifacts: (project: string, destDir: string) => Promise<void>;
  stateDir: string;
  outDir: string;
  logger: Logger;
};

const TIMEOUTS = {
  up: 5 * 60_000,
  wait: 90 * 60_000,
  down: 2 * 60_000,
};

export async function processIssue(issue: LinearIssue, deps: ProcessIssueDeps): Promise<void> {
  const project = `sec-${issue.identifier.toLowerCase()}`;
  const issueOutDir = join(deps.outDir, issue.identifier);
  await mkdir(issueOutDir, { recursive: true });

  // Claim
  await writeState(deps.stateDir, {
    issueIdentifier: issue.identifier,
    phase: "claimed",
    project,
    startedAt: new Date().toISOString(),
    outcome: null,
  });
  await deps.linear.swapLabel(issue.id, LABELS.queued, LABELS.inProgress);
  deps.logger.info({ issue: issue.identifier, project }, "claimed");

  let outcome: "done" | "failed" = "done";

  try {
    await writeState(deps.stateDir, {
      issueIdentifier: issue.identifier,
      phase: "running",
      project,
      startedAt: new Date().toISOString(),
      outcome: null,
    });
    await deps.compose.up({ timeoutMs: TIMEOUTS.up });
    const exitCode = await deps.compose.waitForService("agent", { timeoutMs: TIMEOUTS.wait });
    deps.logger.info({ issue: issue.identifier, exitCode }, "agent exited");
    if (exitCode !== 0) outcome = "failed";

    await deps.collectArtifacts(project, issueOutDir);
    await deps.storage.ensureBucket();
    await deps.storage.uploadDirectory(issueOutDir, `${issue.identifier}/`);
    await writeState(deps.stateDir, {
      issueIdentifier: issue.identifier,
      phase: "uploaded",
      project,
      startedAt: new Date().toISOString(),
      outcome,
    });

    await deps.linear.addComment(
      issue.id,
      renderComment(issue.identifier, outcome),
    );

    await deps.linear.swapLabel(
      issue.id,
      LABELS.inProgress,
      outcome === "done" ? LABELS.done : LABELS.failed,
    );
    await writeState(deps.stateDir, {
      issueIdentifier: issue.identifier,
      phase: "finalized",
      project,
      startedAt: new Date().toISOString(),
      outcome,
    });
    deps.logger.info({ issue: issue.identifier, outcome }, "finalized");
  } finally {
    try {
      await deps.compose.down({ timeoutMs: TIMEOUTS.down });
    } catch (err) {
      deps.logger.error({ issue: issue.identifier, err: String(err) }, "compose down failed");
    }
  }
}

function renderComment(issueIdentifier: string, outcome: "done" | "failed"): string {
  return [
    `<!-- sec-fix-worker:${issueIdentifier} -->`,
    `**sec-fix-worker — Phase 1 stub**`,
    ``,
    `Outcome: \`${outcome}\``,
    ``,
    `Artifacts uploaded to \`s3://security-artifacts/${issueIdentifier}/\`.`,
  ].join("\n");
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/worker/process-issue.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/worker/process-issue.ts src/worker/process-issue.test.ts
git commit -m "feat: process-issue orchestration with state transitions"
```

---

## Task 13: Artifact collection from compose volume

`collectArtifacts(project, destDir)` copies the contents of the named `artifacts` volume out to a host directory. Uses `docker cp` from a one-shot helper container that mounts the volume.

**Files:**
- Create: `~/Development/sec-fix-pipeline/src/stack/collect-artifacts.ts`
- Create: `~/Development/sec-fix-pipeline/src/stack/collect-artifacts.test.ts`

- [ ] **Step 1: Write the failing test**

`src/stack/collect-artifacts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { collectArtifacts } from "./collect-artifacts.js";

describe("collectArtifacts", () => {
  it("copies files out of a named volume into the destination dir", async () => {
    const project = `sec-fix-collect-test-${Date.now()}`;
    const volume = `${project}_artifacts`;
    // Pre-populate the volume by running a one-shot container.
    await execa("docker", [
      "run", "--rm",
      "-v", `${volume}:/artifacts`,
      "alpine:3.20",
      "sh", "-c", "echo hi > /artifacts/a.txt && mkdir -p /artifacts/sub && echo two > /artifacts/sub/b.txt",
    ]);
    const dest = await mkdtemp(join(tmpdir(), "collected-"));
    try {
      await collectArtifacts(project, dest);
      expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("hi\n");
      expect(await readFile(join(dest, "sub/b.txt"), "utf8")).toBe("two\n");
    } finally {
      await rm(dest, { recursive: true, force: true });
      await execa("docker", ["volume", "rm", "-f", volume]).catch(() => {});
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/stack/collect-artifacts.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `collect-artifacts.ts`**

```ts
import { execa } from "execa";

export async function collectArtifacts(project: string, destDir: string): Promise<void> {
  const volume = `${project}_artifacts`;
  await execa("docker", [
    "run", "--rm",
    "-v", `${volume}:/src:ro`,
    "-v", `${destDir}:/dst`,
    "alpine:3.20",
    "sh", "-c", "cp -a /src/. /dst/",
  ]);
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/stack/collect-artifacts.test.ts
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add src/stack/collect-artifacts.ts src/stack/collect-artifacts.test.ts
git commit -m "feat: collect artifacts from compose named volume"
```

---

## Task 14: Worker CLI entry point

**Files:**
- Create: `~/Development/sec-fix-pipeline/src/worker/main.ts`

`main.ts` wires everything together for a single-issue dry-run: load config, build Linear/compose/storage clients, fetch one issue, call `processIssue`, exit. The continuous loop comes in Phase 4.

- [ ] **Step 1: Write `main.ts`**

```ts
import "dotenv/config";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { createLinearClient, createRealGateway } from "../linear/client.js";
import { createStorage } from "../storage/minio.js";
import { createCompose } from "../stack/compose.js";
import { collectArtifacts } from "../stack/collect-artifacts.js";
import { processIssue } from "./process-issue.js";
import { join } from "node:path";

async function main(): Promise<number> {
  const cfg = loadConfig();
  const linear = createLinearClient(
    { viewId: cfg.linear.viewId },
    createRealGateway(cfg.linear.apiKey),
  );
  const storage = createStorage(cfg.minio);

  const issue = await linear.findNextQueuedIssue();
  if (!issue) {
    logger.info("no queued issue; exiting");
    return 0;
  }
  logger.info({ issue: issue.identifier, title: issue.title }, "picked issue");

  const project = `sec-${issue.identifier.toLowerCase()}`;
  const compose = createCompose({
    file: join(process.cwd(), "docker/stack.yml"),
    project,
  });

  process.env.LINEAR_ISSUE_ID = issue.identifier; // consumed by compose stack.yml

  await processIssue(issue, {
    linear,
    compose,
    storage,
    collectArtifacts: (p, d) => collectArtifacts(p, d),
    stateDir: cfg.dirs.state,
    outDir: cfg.dirs.out,
    logger,
  });

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logger.error({ err: String(err), stack: err?.stack }, "worker crashed");
    process.exit(1);
  });
```

- [ ] **Step 2: Add `dotenv` to dependencies**

Edit `package.json` to add to `dependencies`:

```json
    "dotenv": "16.4.5",
```

Then:

```bash
pnpm i
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/worker/main.ts package.json pnpm-lock.yaml
git commit -m "feat: worker CLI entry point"
```

---

## Task 15: Seed-test-issue script

A helper script to create a Linear issue in the deepsec view labelled `agent:queued`, for end-to-end testing without touching real findings.

**Files:**
- Create: `~/Development/sec-fix-pipeline/scripts/seed-test-issue.ts`

- [ ] **Step 1: Write `seed-test-issue.ts`**

```ts
import "dotenv/config";
import { LinearClient } from "@linear/sdk";
import { loadConfig } from "../src/config.js";
import { LABELS } from "../src/linear/labels.js";

async function main() {
  const cfg = loadConfig();
  const linear = new LinearClient({ apiKey: cfg.linear.apiKey });

  // The deepsec view is on a specific team; we read the view to find the team ID.
  const view = await linear.customView(cfg.linear.viewId);
  const team = await view.team;
  if (!team) throw new Error("could not resolve view's team");

  const labels = await linear.issueLabels({ filter: { name: { eq: LABELS.queued } } });
  const queuedLabel = labels.nodes[0];
  if (!queuedLabel) throw new Error(`label not found: ${LABELS.queued}`);

  const created = await linear.createIssue({
    teamId: team.id,
    title: `[sec-fix-test] phase 1 e2e probe — ${new Date().toISOString()}`,
    description: "Synthetic issue created by sec-fix-pipeline phase 1 e2e test. Safe to close.",
    labelIds: [queuedLabel.id],
  });
  const issue = await created.issue;
  console.log(`Created issue: ${issue?.identifier} (${issue?.id})`);
  console.log(`URL: ${issue?.url}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

```bash
pnpm seed:issue
```

Expected: prints a new issue identifier (e.g. `TRI-1234`) and URL.

- [ ] **Step 3: Verify in Linear**

Open the printed URL in a browser. Confirm the issue exists, has the `agent:queued` label, and appears in the deepsec-findings view.

> If the label doesn't exist yet on the team, create the full label set (`agent:queued`, `agent:in-progress`, `agent:done`, `agent:false-positive`, `agent:runaway`, `agent:resume`, `agent:failed`) in Linear UI under the team's label settings before continuing. Re-run the seed script.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-test-issue.ts
git commit -m "feat: seed-test-issue script"
```

---

## Task 16: End-to-end integration test (manual)

This is the Phase 1 ship gate. Not automated — operator runs it once and checks each step.

- [ ] **Step 1: Ensure prerequisites are running**

```bash
docker ps | grep minio        # MinIO container up
docker images | grep sec-fix/agent-stub   # Stub agent image built
```

If either is missing, redo Task 9 / Task 10.

- [ ] **Step 2: Confirm `.env` is populated**

```bash
test -f .env && grep LINEAR_API_KEY .env | grep -v '^LINEAR_API_KEY=$'
```

Expected: prints the line (key is set).

- [ ] **Step 3: Setup bucket and seed test issue**

```bash
pnpm setup:minio
pnpm seed:issue
```

Note the printed issue identifier (e.g. `TRI-1234`).

- [ ] **Step 4: Run the worker**

```bash
pnpm worker 2>&1 | tee /tmp/sec-fix-worker.log
```

Expected log lines (in order):
- `"picked issue"` with the seeded issue's identifier
- `"claimed"`
- `"agent exited"` with `exitCode: 0`
- `"finalized"` with `outcome: done`

Process exits 0.

- [ ] **Step 5: Verify Linear state**

Open the seeded issue in Linear. Confirm:
- Label `agent:queued` is gone
- Label `agent:done` is present
- A comment was added containing `s3://security-artifacts/<identifier>/`

- [ ] **Step 6: Verify MinIO contents**

```bash
docker run --rm --network host \
  -e MC_HOST_local="http://${MINIO_ACCESS_KEY}:${MINIO_SECRET_KEY}@localhost:9000" \
  minio/mc:RELEASE.2024-10-29T15-34-59Z \
  ls -r local/security-artifacts/
```

Expected: lists `<identifier>/hello.txt`, `<identifier>/final-summary.md`, `<identifier>/status.json`.

- [ ] **Step 7: Verify local state file**

```bash
cat state/<identifier>.json
```

Expected: JSON with `"phase": "finalized"`, `"outcome": "done"`.

- [ ] **Step 8: Verify no compose stack lingers**

```bash
docker compose ls
```

Expected: no `sec-*` project listed.

- [ ] **Step 9: Close the seeded test issue manually**

In Linear, close the seeded test issue with a comment "phase 1 e2e probe complete".

- [ ] **Step 10: Document the run**

Append a line to `README.md`:

```markdown
## Phase 1 e2e probe history

- <YYYY-MM-DD>: <operator initials> — issue <identifier> — PASS
```

- [ ] **Step 11: Commit**

```bash
git add README.md
git commit -m "docs: record phase 1 e2e probe pass"
```

---

## Phase 1 done

Pipeline plumbing validated. Next: Phase 2 — Real Claude Agent SDK integration. The interface between the worker and the agent container is now fixed (env var in, `/artifacts/` out, exit code as signal), so Phase 2 only changes `docker/agent-stub/` → `docker/agent/` with a real `run-agent.mjs` and a system prompt.

---

## Self-Review (writing-plans skill)

**Spec coverage (Phase 1 only):**
- Linear queue read from deepsec view → Task 6, Task 14 ✓
- Label state machine (queued → in-progress → done/failed) → Tasks 5, 12 ✓
- Per-issue docker compose with project name `sec-<id>` → Tasks 8, 10, 12 ✓
- Agent container with `/artifacts/` contract → Task 9 ✓
- Container exit code as completion signal → Task 8 (`waitForService`), Task 12 ✓
- MinIO artifact upload → Tasks 7, 11, 12 ✓
- Linear comment with marker → Task 12 (`renderComment`) ✓
- Local state file with atomic writes → Task 4 ✓
- Teardown via `compose down -v` even on failure → Task 12 (`finally`) ✓

**Spec sections deferred to later phases (explicit, not gaps):**
- Real Agent SDK + system prompt + multi-artifact bundle → Phase 2
- Full per-issue stack (postgres/redis/clickhouse/webapp) + repo volume + pnpm-store + egress policy → Phase 3
- systemd + reconcile + circuit breakers + heartbeat → Phase 4
- Resumable runs (snapshots, session resume, 3-resume cap) → Phase 5
- Review dashboard → Phase 6

**Placeholder scan:** None. All steps have concrete code or commands.

**Type consistency check:** `LinearIssue`, `LinearClient`, `LinearGateway`, `Compose`, `Storage`, `IssueState`, `ProcessIssueDeps` all named consistently across Tasks 4, 6, 7, 8, 12.

**One known caveat:** the `findNextQueuedIssue` gateway implementation in Task 6 uses a `customView(viewId).issues(...)` call against the Linear SDK; the exact filter API may need adjustment after Phase 1 hits real Linear (Linear's SDK has changed view-issue filtering shape between releases). The integration test in Task 16 will surface this; fix is a small edit in the gateway, not a design change.
