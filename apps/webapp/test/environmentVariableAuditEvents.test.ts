import type * as EnvServer from "~/env.server";
import { afterEach, describe, expect, vi } from "vitest";

// Points the global client at the fixture's database, also for modules that keep a reference to
// it from load time, such as the RBAC resolver. `$transaction` is the database package's own; only
// the webapp wrapper's span and retry defaults are left out. `wrapTransaction`, when set, wraps the
// transaction client the helper hands to a write (see `interleaveBeforeLock`).
const db = vi.hoisted(() => ({
  client: null as any,
  wrapTransaction: null as ((tx: object) => object) | null,
}));

vi.mock("~/db.server", async () => {
  const actual = await import("@trigger.dev/database");
  const { $transaction } = actual;
  const client = new Proxy(
    {},
    {
      get(_target, property) {
        if (!db.client) throw new Error("Test database not connected");
        const value = Reflect.get(db.client, property);
        return typeof value === "function" ? value.bind(db.client) : value;
      },
    }
  );
  return {
    ...actual,
    prisma: client,
    $replica: client,
    $transaction: (client: any, nameOrFn: unknown, fnOrOptions?: unknown) => {
      const fn = (typeof nameOrFn === "string" ? fnOrOptions : nameOrFn) as (tx: any) => any;
      return $transaction(client, (tx) => fn(db.wrapTransaction?.(tx) ?? tx));
    },
  };
});
// Recording starts off, as in production; `enableAuditRecording` turns it on per test. The rest
// of the environment is the real one, for the routes' authentication.
vi.mock("~/env.server", async (importOriginal) => {
  const actual = await importOriginal<typeof EnvServer>();
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  const { auditRecordingEnv } = await import("./helpers/auditLogPlugin");
  return auditRecordingEnv({
    env: withLegacyEncryptionKeyring({
      ...actual.env,
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    }),
  });
});

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import { action as importVariables } from "~/routes/api.v1.projects.$projectRef.envvars.$slug.import";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import {
  notePersonalAccessTokenAuthentication,
  noteSessionAuthentication,
} from "~/services/auditLogs/auditContext.server";
import { runWithHttpContext } from "~/services/httpAsyncStorage.server";
import { EnvironmentSecretStore } from "~/services/environmentEncryption/secretStore.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  enableAuditRecording,
  inAuditedRequest,
  installAuditLogPlugin,
  uninstallAuditLogPlugin,
} from "./helpers/auditLogPlugin";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  enrollProxyOnlyValue,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

// Every value a test writes contains this, so one check covers them all.
const VALUE_MARKER = "s3cr3t-value";

async function setup(prisma: PrismaClient) {
  db.client = prisma;
  const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
  const production = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
  });
  const staging = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "STAGING",
  });
  const repository = new EnvironmentVariablesRepository(prisma, prisma);
  const { recorded } = installAuditLogPlugin();
  disableRecording = await enableAuditRecording();

  /** Events recorded so far, after checking none of them carries a value. */
  async function events() {
    await auditLogs.flush();
    const inputs = recorded.map((event) => event.input);
    expect(JSON.stringify(inputs)).not.toContain(VALUE_MARKER);
    return inputs;
  }

  async function variableId(key: string) {
    const variable = await prisma.environmentVariable.findFirst({
      where: { projectId: project.id, key },
      select: { id: true },
    });
    if (!variable) throw new Error(`Variable ${key} not found`);
    return variable.id;
  }

  return {
    user,
    organization,
    project,
    production,
    staging,
    repository,
    recorded,
    events,
    variableId,
  };
}

let disableRecording: (() => void) | undefined;

/**
 * Commits `between` once the next write's transaction has begun, before its first raw query: the
 * lock on the variables every write takes first. Another request's write lands after the write's
 * own pre-transaction read and before anything it does under the lock. Returns whether it ran.
 */
function interleaveBeforeLock(between: () => Promise<void>) {
  const state = { ran: false };
  db.wrapTransaction = (tx) =>
    new Proxy(tx, {
      get(target, property) {
        const value = Reflect.get(target, property);
        const fn = typeof value === "function" ? value.bind(target) : value;
        if (property !== "$queryRaw") return fn;
        return async (...args: unknown[]) => {
          if (!state.ran) {
            state.ran = true;
            // The interleaved write runs its own transactions unwrapped.
            db.wrapTransaction = null;
            await between();
          }
          return fn(...args);
        };
      },
    });
  return state;
}

describe("env var audit events", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    disableRecording?.();
    disableRecording = undefined;
    uninstallAuditLogPlugin();
    db.client = null;
    db.wrapTransaction = null;
  });

  // Catches: a create that records no event per environment, records the value, or records a write that changed nothing.
  postgresTest(
    "create records envvar.created per environment, and nothing for an unchanged value",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { organization, project, production, staging, repository, events, variableId } =
          await setup(prisma);

        const create = () =>
          repository.create(project.id, {
            override: true,
            isSecret: true,
            environmentIds: [production.id, staging.id],
            variables: [{ key: "API_TOKEN", value: `${VALUE_MARKER}-1` }],
          });
        expect(await create()).toEqual({ success: true });

        const id = await variableId("API_TOKEN");
        const target = { type: "environment_variable", id, name: "API_TOKEN" };
        expect(await events()).toEqual([
          {
            category: "envvars",
            action: "envvar.created",
            organizationId: organization.id,
            projectId: project.id,
            environmentId: production.id,
            environmentType: "PRODUCTION",
            target,
            changes: { isSecret: true },
          },
          {
            category: "envvars",
            action: "envvar.created",
            organizationId: organization.id,
            projectId: project.id,
            environmentId: staging.id,
            environmentType: "STAGING",
            target,
            changes: { isSecret: true },
          },
        ]);

        // The same value again changes nothing, so it records nothing.
        expect(await create()).toEqual({ success: true });
        expect(await events()).toHaveLength(2);
      })
  );

  // Catches: an override recorded as created, or a secret-flag-only change recorded as a value change (or the reverse).
  postgresTest(
    "overriding a value records envvar.value_updated; toggling only the secret flag records envvar.updated",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { project, production, repository, events, variableId } = await setup(prisma);
        const set = (value: string, isSecret: boolean) =>
          repository.create(project.id, {
            override: true,
            isSecret,
            environmentIds: [production.id],
            variables: [{ key: "DATABASE_URL", value }],
          });

        await set(`${VALUE_MARKER}-old`, false);
        await set(`${VALUE_MARKER}-new`, false);
        await set(`${VALUE_MARKER}-new`, true);
        await set(`${VALUE_MARKER}-newer`, false);

        const id = await variableId("DATABASE_URL");
        expect(
          (await events()).map(({ action, environmentId, target, changes }) => ({
            action,
            environmentId,
            target,
            changes,
          }))
        ).toEqual([
          {
            action: "envvar.created",
            environmentId: production.id,
            target: { type: "environment_variable", id, name: "DATABASE_URL" },
            changes: { isSecret: false },
          },
          {
            action: "envvar.value_updated",
            environmentId: production.id,
            target: { type: "environment_variable", id, name: "DATABASE_URL" },
            changes: null,
          },
          {
            action: "envvar.updated",
            environmentId: production.id,
            target: { type: "environment_variable", id, name: "DATABASE_URL" },
            changes: { isSecret: { before: false, after: true } },
          },
          {
            action: "envvar.value_updated",
            environmentId: production.id,
            target: { type: "environment_variable", id, name: "DATABASE_URL" },
            changes: { isSecret: { before: true, after: false } },
          },
        ]);
      })
  );

  // Catches: edit or editValue recording nothing, or the wrong action, after #writeVariable and clearIgnoredEmpty moved around them.
  postgresTest(
    "edit records value_updated for existing values and created for new ones; editValue records value_updated",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { project, production, staging, repository, events, variableId } =
          await setup(prisma);
        await repository.create(project.id, {
          override: true,
          environmentIds: [production.id],
          variables: [{ key: "REGION", value: `${VALUE_MARKER}-eu` }],
        });
        const id = await variableId("REGION");

        expect(
          await repository.edit(project.id, {
            id,
            values: [
              { environmentId: production.id, value: `${VALUE_MARKER}-us` },
              { environmentId: staging.id, value: `${VALUE_MARKER}-ap` },
            ],
          })
        ).toEqual({ success: true });
        expect(
          await repository.editValue(project.id, {
            id,
            environmentId: staging.id,
            value: `${VALUE_MARKER}-sa`,
          })
        ).toEqual({ success: true });

        expect(
          (await events()).slice(1).map(({ action, environmentId, environmentType, changes }) => ({
            action,
            environmentId,
            environmentType,
            changes,
          }))
        ).toEqual([
          {
            action: "envvar.value_updated",
            environmentId: production.id,
            environmentType: "PRODUCTION",
            changes: null,
          },
          {
            action: "envvar.created",
            environmentId: staging.id,
            environmentType: "STAGING",
            changes: { isSecret: false },
          },
          {
            action: "envvar.value_updated",
            environmentId: staging.id,
            environmentType: "STAGING",
            changes: null,
          },
        ]);
      })
  );

  // Catches: deleteValue (now through deleteValues) recording nothing, or nothing for the variable
  // removed with its last value.
  postgresTest(
    "deleting values and variables records envvar.deleted, though the rows are gone",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { organization, project, production, staging, repository, events, variableId } =
          await setup(prisma);
        for (const key of ["ONE_BY_ONE", "ALL_AT_ONCE"]) {
          await repository.create(project.id, {
            override: true,
            environmentIds: [production.id, staging.id],
            variables: [{ key, value: `${VALUE_MARKER}-${key}` }],
          });
        }
        const oneByOne = await variableId("ONE_BY_ONE");
        const allAtOnce = await variableId("ALL_AT_ONCE");
        const before = (await events()).length;

        // The last value deletes the whole variable.
        expect(
          await repository.deleteValue(project.id, { id: oneByOne, environmentId: production.id })
        ).toEqual({ success: true });
        expect(
          await repository.deleteValue(project.id, { id: oneByOne, environmentId: staging.id })
        ).toEqual({ success: true });
        expect(
          await repository.deleteValues(project.id, [
            { id: allAtOnce, environmentId: production.id },
            { id: allAtOnce, environmentId: staging.id },
          ])
        ).toMatchObject({ success: true });

        expect(
          await prisma.environmentVariable.count({ where: { id: { in: [oneByOne, allAtOnce] } } })
        ).toBe(0);
        // Deletes are recorded in the background, so in any order; each keeps its own time.
        const deleted = (await events()).slice(before);
        expect(deleted).toHaveLength(4);
        expect(deleted).toEqual(
          expect.arrayContaining(
            [
              { id: oneByOne, name: "ONE_BY_ONE", environment: production },
              { id: oneByOne, name: "ONE_BY_ONE", environment: staging },
              { id: allAtOnce, name: "ALL_AT_ONCE", environment: production },
              { id: allAtOnce, name: "ALL_AT_ONCE", environment: staging },
            ].map(({ id, name, environment }) => ({
              category: "envvars",
              action: "envvar.deleted",
              organizationId: organization.id,
              projectId: project.id,
              environmentId: environment.id,
              environmentType: environment.type,
              target: { type: "environment_variable", id, name },
              changes: null,
            }))
          )
        );
      })
  );

  // Catches: an import that drops the imported marker or records keys it left unchanged.
  postgresTest(
    "an import records each changed key with imported: true, and nothing for unchanged keys",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { organization, project, production, repository, events, variableId } =
          await setup(prisma);
        await repository.create(project.id, {
          override: true,
          isSecret: true,
          environmentIds: [production.id],
          variables: [
            { key: "EXISTING", value: `${VALUE_MARKER}-a` },
            { key: "UNCHANGED", value: `${VALUE_MARKER}-b` },
          ],
        });
        const before = (await events()).length;

        expect(
          await repository.create(
            project.id,
            {
              override: true,
              isSecret: false,
              environmentIds: [production.id],
              variables: [
                { key: "EXISTING", value: `${VALUE_MARKER}-c` },
                { key: "NEW_ONE", value: `${VALUE_MARKER}-d` },
              ],
            },
            { imported: true }
          )
        ).toEqual({ success: true });
        // Same value, same flag: nothing changes.
        expect(
          await repository.create(
            project.id,
            {
              override: true,
              environmentIds: [production.id],
              variables: [{ key: "UNCHANGED", value: `${VALUE_MARKER}-b` }],
            },
            { imported: true }
          )
        ).toEqual({ success: true });

        const event = (key: string, id: string, action: string, changes: unknown) => ({
          category: "envvars",
          action,
          organizationId: organization.id,
          projectId: project.id,
          environmentId: production.id,
          environmentType: "PRODUCTION",
          target: { type: "environment_variable", id, name: key },
          changes,
        });
        expect((await events()).slice(before)).toEqual([
          event("EXISTING", await variableId("EXISTING"), "envvar.value_updated", {
            isSecret: { before: true, after: false },
            imported: true,
          }),
          event("NEW_ONE", await variableId("NEW_ONE"), "envvar.created", {
            isSecret: false,
            imported: true,
          }),
        ]);
      })
  );

  // Catches: the import route losing `imported: true` or the inherited secret flag for a branch.
  postgresTest(
    "the import route records each key with imported: true in a preview branch and its parent",
    async ({ prisma }) => {
      const { organization, project, repository, recorded, events, variableId } =
        await setup(prisma);
      const preview = await prisma.runtimeEnvironment.create({
        data: {
          slug: "preview",
          type: "PREVIEW",
          isBranchableEnvironment: true,
          projectId: project.id,
          organizationId: organization.id,
          apiKey: `tr_preview_${project.id}`,
          pkApiKey: `pk_preview_${project.id}`,
          shortcode: `sc_preview_${project.id}`,
        },
      });
      const branch = await prisma.runtimeEnvironment.create({
        data: {
          slug: "preview-feat-audit",
          type: "PREVIEW",
          branchName: "feat-audit",
          parentEnvironmentId: preview.id,
          projectId: project.id,
          organizationId: organization.id,
          apiKey: `tr_branch_${project.id}`,
          pkApiKey: `pk_branch_${project.id}`,
          shortcode: `sc_branch_${project.id}`,
        },
      });
      // The branch inherits the parent's secret flag for a key it doesn't have yet.
      await repository.create(project.id, {
        override: true,
        isSecret: true,
        environmentIds: [preview.id],
        variables: [{ key: "INHERITED_SECRET", value: `${VALUE_MARKER}-a` }],
      });
      await repository.create(project.id, {
        override: true,
        environmentIds: [preview.id],
        variables: [{ key: "PARENT_SAME", value: `${VALUE_MARKER}-b` }],
      });
      const before = (await events()).length;

      const response = await runWithHttpContext(
        {
          requestId: "req_envvar_import",
          path: `/api/v1/projects/${project.externalRef}/envvars/preview/import`,
          host: "api.trigger.dev",
          method: "POST",
          abortController: new AbortController(),
        },
        () =>
          importVariables({
            params: { projectRef: project.externalRef, slug: "preview" },
            context: {},
            request: new Request(
              `http://localhost/api/v1/projects/${project.externalRef}/envvars/preview/import`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${preview.apiKey}`,
                  "content-type": "application/json",
                  "x-trigger-branch": "feat-audit",
                },
                body: JSON.stringify({
                  variables: {
                    INHERITED_SECRET: `${VALUE_MARKER}-c`,
                    BRANCH_ONLY: `${VALUE_MARKER}-d`,
                  },
                  parentVariables: {
                    PARENT_SAME: `${VALUE_MARKER}-b`,
                    PARENT_NEW: `${VALUE_MARKER}-e`,
                  },
                  override: true,
                }),
              }
            ),
          })
      );
      expect(response.status).toBe(200);

      const event = (key: string, id: string, environmentId: string, isSecret: boolean) => ({
        category: "envvars",
        action: "envvar.created",
        organizationId: organization.id,
        projectId: project.id,
        environmentId,
        environmentType: "PREVIEW",
        target: { type: "environment_variable", id, name: key },
        changes: { isSecret, imported: true },
      });
      // PARENT_SAME is unchanged, so it isn't recorded.
      expect((await events()).slice(before)).toEqual([
        event("INHERITED_SECRET", await variableId("INHERITED_SECRET"), branch.id, true),
        event("BRANCH_ONLY", await variableId("BRANCH_ONLY"), branch.id, false),
        event("PARENT_NEW", await variableId("PARENT_NEW"), preview.id, false),
      ]);
      for (const { context } of recorded.slice(before)) {
        expect(context.requestId).toBe("req_envvar_import");
        expect(context.source).toBe("api");
      }
    }
  );

  // Catches: a Vercel pull that drops `via: "vercel"` or records keys it left unchanged.
  postgresTest(
    "a Vercel pull records each changed key with imported: true and via: vercel",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { organization, project, production, repository, events, variableId } =
          await setup(prisma);
        await repository.create(project.id, {
          override: true,
          isSecret: true,
          environmentIds: [production.id],
          variables: [{ key: "VERCEL_SECRET", value: `${VALUE_MARKER}-old` }],
        });
        await repository.create(project.id, {
          override: true,
          environmentIds: [production.id],
          variables: [{ key: "VERCEL_SAME", value: `${VALUE_MARKER}-same` }],
        });
        const before = (await events()).length;

        const vercelVariable = (key: string, value: string) => ({
          id: key,
          key,
          value,
          type: "plain",
          target: ["production"],
        });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.hostname !== "api.vercel.com") {
            throw new Error(`Unexpected request: ${url.origin}`);
          }
          if (url.pathname === "/v1/env") {
            return Response.json({ data: [], pagination: { next: null } });
          }
          if (/\/projects\/prj_fixture\/env$/.test(url.pathname)) {
            return Response.json({
              envs: [
                vercelVariable("VERCEL_PLAIN", `${VALUE_MARKER}-plain`),
                vercelVariable("VERCEL_SECRET", `${VALUE_MARKER}-new`),
                vercelVariable("VERCEL_SAME", `${VALUE_MARKER}-same`),
              ],
            });
          }
          throw new Error(`Unexpected Vercel request: ${url.pathname}`);
        });
        const tokenKey = `vercel-fixture-${project.id}`;
        await getSecretStore("DATABASE", { prismaClient: prisma }).setSecret(tokenKey, {
          accessToken: "fixture-only-token",
        });
        const integration = await prisma.organizationIntegration.create({
          data: {
            friendlyId: `int_${project.id}`,
            service: "VERCEL",
            integrationData: {},
            organization: { connect: { id: organization.id } },
            tokenReference: { create: { key: tokenKey } },
          },
          include: { tokenReference: true },
        });

        const pulled = await VercelIntegrationRepository.pullEnvVarsFromVercel({
          projectId: project.id,
          vercelProjectId: "prj_fixture",
          teamId: "team_fixture",
          syncEnvVarsMapping: {},
          orgIntegration: integration,
        });
        expect(pulled.isOk() && pulled.value).toEqual({ syncedCount: 2, errors: [] });

        const event = (key: string, id: string, action: string, changes: unknown) => ({
          category: "envvars",
          action,
          organizationId: organization.id,
          projectId: project.id,
          environmentId: production.id,
          environmentType: "PRODUCTION",
          target: { type: "environment_variable", id, name: key },
          changes,
        });
        // Plain and secret keys are written by separate calls; VERCEL_SAME is unchanged.
        expect((await events()).slice(before)).toEqual([
          event("VERCEL_PLAIN", await variableId("VERCEL_PLAIN"), "envvar.created", {
            isSecret: false,
            imported: true,
            via: "vercel",
          }),
          event("VERCEL_SECRET", await variableId("VERCEL_SECRET"), "envvar.value_updated", {
            imported: true,
            via: "vercel",
          }),
        ]);
      })
  );

  // Catches: edit or editValue recording a save that keeps the stored value.
  postgresTest(
    "edit and editValue with the stored value record nothing, though they still write it",
    async ({ prisma }) => {
      const { project, production, repository, events, variableId } = await setup(prisma);
      await repository.create(project.id, {
        override: true,
        environmentIds: [production.id],
        variables: [{ key: "REGION", value: `${VALUE_MARKER}-eu` }],
      });
      const id = await variableId("REGION");
      const before = (await events()).length;

      expect(
        await repository.edit(project.id, {
          id,
          values: [{ environmentId: production.id, value: `${VALUE_MARKER}-eu` }],
        })
      ).toEqual({ success: true });
      expect(
        await repository.editValue(project.id, {
          id,
          environmentId: production.id,
          value: `${VALUE_MARKER}-eu`,
        })
      ).toEqual({ success: true });

      expect((await events()).slice(before)).toEqual([]);
      const stored = await prisma.environmentVariableValue.findFirstOrThrow({
        where: { variableId: id, environmentId: production.id },
      });
      expect(stored.version).toBe(3);
    }
  );

  // Catches: audit-only reads of stored values running while recording is off.
  postgresTest(
    "edit and editValue read the stored value only while recording is on",
    async ({ prisma }) => {
      const { project, production, repository, variableId } = await setup(prisma);
      await repository.create(project.id, {
        override: true,
        environmentIds: [production.id],
        variables: [{ key: "REGION", value: `${VALUE_MARKER}-eu` }],
      });
      const id = await variableId("REGION");
      const secretReads = vi.spyOn(EnvironmentSecretStore.prototype, "getSecretsByKeys");
      const editBoth = async (value: string) => {
        expect(
          await repository.edit(project.id, {
            id,
            values: [{ environmentId: production.id, value }],
          })
        ).toEqual({ success: true });
        expect(
          await repository.editValue(project.id, { id, environmentId: production.id, value })
        ).toEqual({ success: true });
      };

      try {
        await editBoth(`${VALUE_MARKER}-us`);
        expect(secretReads).toHaveBeenCalledTimes(2);

        secretReads.mockClear();
        disableRecording?.();
        await editBoth(`${VALUE_MARKER}-ap`);
        expect(secretReads).not.toHaveBeenCalled();
      } finally {
        secretReads.mockRestore();
      }
      const stored = await prisma.environmentVariableValue.findFirstOrThrow({
        where: { variableId: id, environmentId: production.id },
      });
      expect(stored.version).toBe(5);
    }
  );

  // Catches: edit skipping an event when another write replaced the value between its read and its update.
  postgresTest(
    "edit records the stored value when another write lands between its read and its update",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { project, production, repository, events, variableId } = await setup(prisma);
        await repository.create(project.id, {
          override: true,
          environmentIds: [production.id],
          variables: [{ key: "REGION", value: `${VALUE_MARKER}-a` }],
        });
        const id = await variableId("REGION");
        const before = (await events()).length;

        // Commits a write of "b" after the edit reads the stored value, before it writes: the edit
        // then saves "a" over "b", which changes the value.
        const interleaved = interleaveBeforeLock(async () => {
          expect(
            await repository.editValue(project.id, {
              id,
              environmentId: production.id,
              value: `${VALUE_MARKER}-b`,
            })
          ).toEqual({ success: true });
        });

        expect(
          await repository.edit(project.id, {
            id,
            values: [{ environmentId: production.id, value: `${VALUE_MARKER}-a` }],
          })
        ).toEqual({ success: true });

        expect(interleaved.ran).toBe(true);
        const stored = await prisma.environmentVariableValue.findFirstOrThrow({
          where: { variableId: id, environmentId: production.id },
        });
        expect(stored.version).toBe(3);
        expect((await events()).slice(before).map(({ action }) => action)).toEqual([
          "envvar.value_updated",
          "envvar.value_updated",
        ]);
      })
  );

  // Catches: edit taking a value deleted and created again (its version restarting) between its
  // read and its update for the value it read, and recording nothing.
  postgresTest(
    "edit records a value deleted and created again between its read and its update",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { project, production, staging, repository, events, variableId } =
          await setup(prisma);
        // Also set in staging, so deleting the production value keeps the variable.
        await repository.create(project.id, {
          override: true,
          environmentIds: [production.id, staging.id],
          variables: [{ key: "REGION", value: `${VALUE_MARKER}-a` }],
        });
        const id = await variableId("REGION");
        const original = await prisma.environmentVariableValue.findFirstOrThrow({
          where: { variableId: id, environmentId: production.id },
        });
        const before = (await events()).length;

        // Deletes the value and sets it again to "b" after the edit reads the stored value: the new
        // row is back at the version the edit read, and the edit saves "a" over "b".
        const interleaved = interleaveBeforeLock(async () => {
          expect(
            await repository.deleteValue(project.id, { id, environmentId: production.id })
          ).toEqual({ success: true });
          expect(
            await repository.create(project.id, {
              override: true,
              environmentIds: [production.id],
              variables: [{ key: "REGION", value: `${VALUE_MARKER}-b` }],
            })
          ).toEqual({ success: true });
        });

        expect(
          await repository.edit(project.id, {
            id,
            values: [{ environmentId: production.id, value: `${VALUE_MARKER}-a` }],
          })
        ).toEqual({ success: true });

        expect(interleaved.ran).toBe(true);
        const stored = await prisma.environmentVariableValue.findFirstOrThrow({
          where: { variableId: id, environmentId: production.id },
        });
        expect(stored.id).not.toBe(original.id);
        expect(stored.version).toBe(original.version + 1);
        // The delete is recorded in the background, so it can land in any position.
        expect(
          (await events())
            .slice(before)
            .map(({ action }) => action)
            .sort()
        ).toEqual(["envvar.created", "envvar.deleted", "envvar.value_updated"]);
      })
  );

  // Catches: a copy comparing the target's stored value with the version it read before its
  // update, and recording nothing when it overwrites a value another request just saved.
  postgresTest(
    "copyValues records a value another write saved between its read and its update",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { project, production, staging, repository, events, variableId } =
          await setup(prisma);
        for (const environmentId of [staging.id, production.id]) {
          await repository.create(project.id, {
            override: true,
            environmentIds: [environmentId],
            variables: [{ key: "REGION", value: `${VALUE_MARKER}-a` }],
          });
        }
        const id = await variableId("REGION");
        const before = (await events()).length;

        // Saves "b" in the target after the copy reads its stored value, before it updates it: the
        // copy then saves "a" over "b", which changes the value.
        const interleaved = interleaveBeforeLock(async () => {
          expect(
            await repository.editValue(project.id, {
              id,
              environmentId: production.id,
              value: `${VALUE_MARKER}-b`,
            })
          ).toEqual({ success: true });
        });

        expect(
          await repository.copyValues(project.id, {
            sourceEnvironmentId: staging.id,
            targetEnvironmentId: production.id,
            variableIds: [id],
          })
        ).toMatchObject({ success: true });

        expect(interleaved.ran).toBe(true);
        const stored = await prisma.environmentVariableValue.findFirstOrThrow({
          where: { variableId: id, environmentId: production.id },
        });
        expect(stored.version).toBe(3);
        expect((await events()).slice(before).map(({ action }) => action)).toEqual([
          "envvar.value_updated",
          "envvar.value_updated",
        ]);
      })
  );

  // Catches: a save that makes a value a secret recorded as a flag-only change when another
  // request saved a different value between its read and its update.
  postgresTest(
    "create records a value change, not only the secret flag, when another write lands first",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { project, production, repository, events, variableId } = await setup(prisma);
        const set = (isSecret: boolean) =>
          repository.create(project.id, {
            override: true,
            isSecret,
            environmentIds: [production.id],
            variables: [{ key: "REGION", value: `${VALUE_MARKER}-a` }],
          });
        await set(false);
        const id = await variableId("REGION");
        const before = (await events()).length;

        // Saves "b" after the create reads the stored value, before it updates it: the create then
        // saves "a" over "b" as a secret, which changes the value too.
        const interleaved = interleaveBeforeLock(async () => {
          expect(
            await repository.editValue(project.id, {
              id,
              environmentId: production.id,
              value: `${VALUE_MARKER}-b`,
            })
          ).toEqual({ success: true });
        });

        expect(await set(true)).toEqual({ success: true });

        expect(interleaved.ran).toBe(true);
        expect(
          (await events()).slice(before).map(({ action, changes }) => ({ action, changes }))
        ).toEqual([
          { action: "envvar.value_updated", changes: null },
          { action: "envvar.value_updated", changes: { isSecret: { before: false, after: true } } },
        ]);
      })
  );

  // Catches: a bulk delete that records nothing, a summary instead of one event per value, an
  // event for a value that was already gone, or none for a variable removed with its last value.
  postgresTest("deleteValues records one envvar.deleted per value it deleted", async ({ prisma }) =>
    inAuditedRequest(async () => {
      const { organization, project, production, staging, repository, events, variableId } =
        await setup(prisma);
      for (const key of ["KEEPS_STAGING", "GOES_AWAY", "ALREADY_GONE"]) {
        await repository.create(project.id, {
          override: true,
          environmentIds: [production.id, staging.id],
          variables: [{ key, value: `${VALUE_MARKER}-${key}` }],
        });
      }
      const keepsStaging = await variableId("KEEPS_STAGING");
      const goesAway = await variableId("GOES_AWAY");
      const alreadyGone = await variableId("ALREADY_GONE");
      expect(
        await repository.deleteValue(project.id, { id: alreadyGone, environmentId: production.id })
      ).toEqual({ success: true });
      const before = (await events()).length;

      const result = await repository.deleteValues(project.id, [
        { id: keepsStaging, environmentId: production.id },
        { id: goesAway, environmentId: production.id },
        { id: goesAway, environmentId: staging.id },
        // Deleted above, so not deleted again.
        { id: alreadyGone, environmentId: production.id },
      ]);
      expect(result.success && result.deleted).toHaveLength(3);

      expect(await prisma.environmentVariable.count({ where: { id: goesAway } })).toBe(0);
      expect(await prisma.environmentVariable.count({ where: { id: keepsStaging } })).toBe(1);
      const deleted = (await events()).slice(before);
      expect(deleted).toHaveLength(3);
      expect(deleted).toEqual(
        expect.arrayContaining(
          [
            { id: keepsStaging, name: "KEEPS_STAGING", environment: production },
            { id: goesAway, name: "GOES_AWAY", environment: production },
            { id: goesAway, name: "GOES_AWAY", environment: staging },
          ].map(({ id, name, environment }) => ({
            category: "envvars",
            action: "envvar.deleted",
            organizationId: organization.id,
            projectId: project.id,
            environmentId: environment.id,
            environmentType: environment.type,
            target: { type: "environment_variable", id, name },
            changes: null,
          }))
        )
      );

      // Nothing left to delete records nothing.
      expect(
        await repository.deleteValues(project.id, [{ id: goesAway, environmentId: production.id }])
      ).toEqual({ success: true, deleted: [] });
      expect((await events()).slice(before)).toHaveLength(3);
    })
  );

  // Catches: a copy that records nothing, the wrong action for a new or replaced value, a missing
  // copiedFrom, a lost secret flag change, an event for a value the target already held, or the
  // value itself (checked by events()).
  postgresTest(
    "copyValues records created or value_updated per key, with where it was copied from",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { organization, project, production, staging, repository, events, variableId } =
          await setup(prisma);
        const set = (environmentId: string, key: string, value: string, isSecret = false) =>
          repository.create(project.id, {
            override: true,
            isSecret,
            environmentIds: [environmentId],
            variables: [{ key, value }],
          });
        await set(staging.id, "NEW_IN_PROD", `${VALUE_MARKER}-1`);
        await set(staging.id, "SECRET_NEW", `${VALUE_MARKER}-2`, true);
        await set(staging.id, "REPLACED", `${VALUE_MARKER}-3`);
        await set(production.id, "REPLACED", `${VALUE_MARKER}-old`);
        await set(staging.id, "BECOMES_SECRET", `${VALUE_MARKER}-4`, true);
        await set(production.id, "BECOMES_SECRET", `${VALUE_MARKER}-plain`);
        await set(staging.id, "SAME", `${VALUE_MARKER}-5`);
        await set(production.id, "SAME", `${VALUE_MARKER}-5`);
        await set(staging.id, "SAME_NOW_SECRET", `${VALUE_MARKER}-6`, true);
        await set(production.id, "SAME_NOW_SECRET", `${VALUE_MARKER}-6`);
        const before = (await events()).length;

        const keys = [
          "NEW_IN_PROD",
          "SECRET_NEW",
          "REPLACED",
          "BECOMES_SECRET",
          "SAME",
          "SAME_NOW_SECRET",
        ];
        const ids = Object.fromEntries(
          await Promise.all(keys.map(async (key) => [key, await variableId(key)] as const))
        );
        const result = await repository.copyValues(project.id, {
          sourceEnvironmentId: staging.id,
          targetEnvironmentId: production.id,
          variableIds: keys.map((key) => ids[key]),
        });
        expect(result.success).toBe(true);

        const copiedFrom = {
          copiedFromEnvironmentId: staging.id,
          copiedFromEnvironmentName: staging.slug,
        };
        const event = (key: string, action: string, changes: unknown) => ({
          category: "envvars",
          action,
          organizationId: organization.id,
          projectId: project.id,
          environmentId: production.id,
          environmentType: "PRODUCTION",
          target: { type: "environment_variable", id: ids[key], name: key },
          changes,
        });
        // In key order, as the copy writes them. SAME is unchanged, so it isn't recorded.
        expect((await events()).slice(before)).toEqual([
          event("BECOMES_SECRET", "envvar.value_updated", {
            isSecret: { before: false, after: true },
            ...copiedFrom,
          }),
          event("NEW_IN_PROD", "envvar.created", { isSecret: false, ...copiedFrom }),
          event("REPLACED", "envvar.value_updated", { ...copiedFrom }),
          event("SAME_NOW_SECRET", "envvar.updated", {
            isSecret: { before: false, after: true },
            ...copiedFrom,
          }),
          event("SECRET_NEW", "envvar.created", { isSecret: true, ...copiedFrom }),
        ]);

        // The same copy again changes nothing, so it records nothing.
        expect(
          await repository.copyValues(project.id, {
            sourceEnvironmentId: staging.id,
            targetEnvironmentId: production.id,
            variableIds: keys.map((key) => ids[key]),
          })
        ).toMatchObject({ success: true });
        expect((await events()).slice(before)).toHaveLength(5);
      })
  );

  // Catches: a copy recording a preview branch by its environment slug instead of its branch name.
  postgresTest("copyValues names a source branch by its branch name", async ({ prisma }) =>
    inAuditedRequest(async () => {
      const { organization, project, production, repository, events, variableId } =
        await setup(prisma);
      const preview = await prisma.runtimeEnvironment.create({
        data: {
          slug: "preview",
          type: "PREVIEW",
          isBranchableEnvironment: true,
          projectId: project.id,
          organizationId: organization.id,
          apiKey: `tr_preview_${project.id}`,
          pkApiKey: `pk_preview_${project.id}`,
          shortcode: `sc_preview_${project.id}`,
        },
      });
      const branch = await prisma.runtimeEnvironment.create({
        data: {
          slug: "preview-feat-copy",
          type: "PREVIEW",
          branchName: "feat-copy",
          parentEnvironmentId: preview.id,
          projectId: project.id,
          organizationId: organization.id,
          apiKey: `tr_branch_${project.id}`,
          pkApiKey: `pk_branch_${project.id}`,
          shortcode: `sc_branch_${project.id}`,
        },
      });
      await repository.create(project.id, {
        override: true,
        environmentIds: [branch.id],
        variables: [{ key: "FROM_BRANCH", value: `${VALUE_MARKER}-b` }],
      });
      const before = (await events()).length;

      expect(
        await repository.copyValues(project.id, {
          sourceEnvironmentId: branch.id,
          targetEnvironmentId: production.id,
          variableIds: [await variableId("FROM_BRANCH")],
        })
      ).toMatchObject({ success: true });

      expect((await events()).slice(before).map(({ changes }) => changes)).toEqual([
        {
          isSecret: false,
          copiedFromEnvironmentId: branch.id,
          copiedFromEnvironmentName: "feat-copy",
        },
      ]);
    })
  );

  // Catches: audit-only reads of the target's values running while recording is off.
  postgresTest(
    "copyValues reads the target's values only while recording is on",
    async ({ prisma }) => {
      const { project, production, staging, repository, variableId } = await setup(prisma);
      await repository.create(project.id, {
        override: true,
        environmentIds: [staging.id, production.id],
        variables: [{ key: "REGION", value: `${VALUE_MARKER}-eu` }],
      });
      const copy = async () =>
        expect(
          await repository.copyValues(project.id, {
            sourceEnvironmentId: staging.id,
            targetEnvironmentId: production.id,
            variableIds: [await variableId("REGION")],
          })
        ).toMatchObject({ success: true });
      const secretReads = vi.spyOn(EnvironmentSecretStore.prototype, "getSecretsByKeys");
      try {
        await copy();
        // The source, read by the copy, and the target, read for the audit log.
        expect(secretReads).toHaveBeenCalledTimes(2);

        secretReads.mockClear();
        disableRecording?.();
        await copy();
        expect(secretReads).toHaveBeenCalledTimes(1);
      } finally {
        secretReads.mockRestore();
      }
    }
  );

  // Catches: an event recorded for a write that was refused or rolled back.
  postgresTest("refused and rolled-back changes record nothing", async ({ prisma }) => {
    const { project, production, staging, repository, events, variableId } = await setup(prisma);
    await repository.create(project.id, {
      override: true,
      environmentIds: [production.id, staging.id],
      variables: [{ key: "PROXIED", value: `${VALUE_MARKER}-p` }],
    });
    const proxied = await variableId("PROXIED");
    await enrollProxyOnlyValue(prisma, {
      environmentId: production.id,
      variableId: proxied,
      allowedHosts: ["api.example.com"],
    });
    const before = (await events()).length;

    // Refused before any write: the key already exists and override is off.
    const conflict = await repository.create(project.id, {
      override: false,
      environmentIds: [production.id],
      variables: [{ key: "PROXIED", value: `${VALUE_MARKER}-q` }],
    });
    expect(conflict.success).toBe(false);

    // Each of these fails inside its transaction, on the proxy-only guard, and rolls back.
    expect(
      await repository.create(project.id, {
        override: true,
        environmentIds: [production.id],
        variables: [{ key: "PROXIED", value: `${VALUE_MARKER}-r` }],
      })
    ).toMatchObject({ success: false });
    expect(
      await repository.edit(project.id, {
        id: proxied,
        values: [{ environmentId: production.id, value: `${VALUE_MARKER}-s` }],
      })
    ).toMatchObject({ success: false });
    expect(
      await repository.editValue(project.id, {
        id: proxied,
        environmentId: production.id,
        value: `${VALUE_MARKER}-t`,
      })
    ).toMatchObject({ success: false });
    expect(
      await repository.copyValues(project.id, {
        sourceEnvironmentId: staging.id,
        targetEnvironmentId: production.id,
        variableIds: [proxied],
      })
    ).toMatchObject({ success: false });
    expect(
      await repository.deleteValues(project.id, [
        { id: proxied, environmentId: staging.id },
        { id: proxied, environmentId: production.id },
      ])
    ).toMatchObject({ success: false });
    expect(
      await repository.deleteValue(project.id, { id: proxied, environmentId: production.id })
    ).toMatchObject({ success: false });

    expect(await prisma.environmentVariableValue.count({ where: { variableId: proxied } })).toBe(2);
    expect((await events()).length).toBe(before);
  });

  // Catches: a failing key losing the events of keys already committed before it.
  postgresTest(
    "a failed import still records the keys committed before the failure",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { organization, project, production, repository, events, variableId } =
          await setup(prisma);
        await repository.create(project.id, {
          override: true,
          environmentIds: [production.id],
          variables: [{ key: "PROXIED", value: `${VALUE_MARKER}-p` }],
        });
        await enrollProxyOnlyValue(prisma, {
          environmentId: production.id,
          variableId: await variableId("PROXIED"),
          allowedHosts: ["api.example.com"],
        });
        const before = (await events()).length;

        const result = await repository.create(
          project.id,
          {
            override: true,
            environmentIds: [production.id],
            variables: [
              { key: "FIRST", value: `${VALUE_MARKER}-1` },
              { key: "PROXIED", value: `${VALUE_MARKER}-2` },
            ],
          },
          { imported: true }
        );

        expect(result.success).toBe(false);
        expect((await events()).slice(before)).toEqual([
          {
            category: "envvars",
            action: "envvar.created",
            organizationId: organization.id,
            projectId: project.id,
            environmentId: production.id,
            environmentType: "PRODUCTION",
            target: { type: "environment_variable", id: await variableId("FIRST"), name: "FIRST" },
            changes: { isSecret: false, imported: true },
          },
        ]);
      })
  );

  // Catches: a delete event recorded in the background losing the request's actor and source.
  postgresTest("an event recorded in a dashboard request names the user", async ({ prisma }) => {
    const { user, project, production, repository, recorded, variableId } = await setup(prisma);
    await repository.create(project.id, {
      override: true,
      environmentIds: [production.id],
      variables: [{ key: "TO_DELETE", value: `${VALUE_MARKER}-x` }],
    });
    const id = await variableId("TO_DELETE");

    await runWithHttpContext(
      {
        requestId: "req_envvar_delete",
        path: "/orgs/org/projects/project/env/prod/environment-variables",
        host: "cloud.trigger.dev",
        method: "POST",
        abortController: new AbortController(),
      },
      async () => {
        noteSessionAuthentication(new Request("https://cloud.trigger.dev/"), { userId: user.id });
        await repository.deleteValue(project.id, { id, environmentId: production.id });
      }
    );
    await auditLogs.flush();

    const deletion = recorded.find((event) => event.input.action === "envvar.deleted");
    expect(deletion?.input.target).toEqual({
      type: "environment_variable",
      id,
      name: "TO_DELETE",
    });
    expect(deletion?.context).toMatchObject({
      actor: { type: "user", id: user.id },
      source: "dashboard",
      requestId: "req_envvar_delete",
    });
  });

  // Catches: an import event losing the personal access token or CLI source of its request.
  postgresTest(
    "an event recorded in a CLI request with a personal access token names the user and the token",
    async ({ prisma }) => {
      const { user, organization, project, production, repository, recorded, variableId } =
        await setup(prisma);
      const token = "tr_pat_0123456789abcdefwxyz";

      await runWithHttpContext(
        {
          requestId: "req_envvar_cli_import",
          path: `/api/v1/projects/${project.externalRef}/envvars/prod/import`,
          host: "api.trigger.dev",
          method: "POST",
          abortController: new AbortController(),
        },
        async () => {
          notePersonalAccessTokenAuthentication(
            new Request("https://api.trigger.dev/", {
              headers: {
                authorization: `Bearer ${token}`,
                "x-trigger-source": "cli",
                "user-agent": "trigger.dev-cli/4.0.0",
                "x-forwarded-for": "203.0.113.7",
              },
            }),
            { userId: user.id, tokenId: "pat_cli" }
          );
          await repository.create(
            project.id,
            {
              override: true,
              environmentIds: [production.id],
              variables: [{ key: "FROM_CLI", value: `${VALUE_MARKER}-cli` }],
            },
            { imported: true }
          );
        }
      );
      await auditLogs.flush();

      expect(recorded).toEqual([
        {
          input: {
            category: "envvars",
            action: "envvar.created",
            organizationId: organization.id,
            projectId: project.id,
            environmentId: production.id,
            environmentType: "PRODUCTION",
            target: {
              type: "environment_variable",
              id: await variableId("FROM_CLI"),
              name: "FROM_CLI",
            },
            changes: { isSecret: false, imported: true },
          },
          context: {
            occurredAt: expect.any(Date),
            actor: { type: "user", id: user.id },
            credential: { kind: "pat", id: "pat_cli", last4: "wxyz", fingerprintId: null },
            onBehalfOf: null,
            source: "cli",
            endpoint: { ip: "203.0.113.7", userAgent: "trigger.dev-cli/4.0.0" },
            origin: null,
            requestId: "req_envvar_cli_import",
          },
        },
      ]);
    }
  );
});
