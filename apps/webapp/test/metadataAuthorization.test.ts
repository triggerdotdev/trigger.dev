import { PostgresRunStore } from "@internal/run-store";
import { postgresTest, redisTest } from "@internal/testcontainers";
import { buildJwtAbility } from "@trigger.dev/plugins";
import { RunId, generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { MollifierBuffer } from "@trigger.dev/redis-worker";
import { describe, expect } from "vitest";
import { UpdateMetadataService } from "~/services/metadata/updateMetadata.server";
import { applyMetadataMutationToBufferedRun } from "~/v3/mollifier/applyMetadataMutation.server";

const increment = [{ type: "increment" as const, key: "count", value: 1 }];

describe("metadata target authorization", () => {
  postgresTest(
    "checks every target before writing or ingesting, and accepts admin scopes",
    async ({ prisma }) => {
      const organization = await prisma.organization.create({
        data: { title: "test", slug: "test" },
      });
      const project = await prisma.project.create({
        data: { name: "test", slug: "test", organizationId: organization.id, externalRef: "test" },
      });
      const environment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });
      const authEnvironment = { ...environment, project, organization };
      const createRun = (parentTaskRunId?: string, rootTaskRunId?: string) =>
        prisma.taskRun.create({
          data: {
            ...RunId.generate(),
            taskIdentifier: "my-task",
            payload: "{}",
            traceId: "1234",
            spanId: "1234",
            queue: "test",
            runtimeEnvironmentId: environment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
            parentTaskRunId,
            rootTaskRunId,
          },
        });
      const root = await createRun();
      const parent = await createRun(undefined, root.id);
      const child = await createRun(parent.id, root.id);
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        flushEnabled: false,
      });
      const body = {
        metadata: { accepted: true },
        parentOperations: increment,
        rootOperations: increment,
      };

      for (const scopes of [
        [`write:runs:${child.friendlyId}`],
        [`write:runs:${child.friendlyId}`, `write:runs:${parent.friendlyId}`],
      ]) {
        await expect(
          service.call(child.friendlyId, body, authEnvironment, {
            ability: buildJwtAbility(scopes),
          })
        ).rejects.toMatchObject({ status: 403 });
        await service.flushOperations();
        const runs = await prisma.taskRun.findMany({
          where: { id: { in: [root.id, parent.id, child.id] } },
        });
        expect(runs.every((run) => run.metadata === null)).toBe(true);
      }

      const options = {
        ability: buildJwtAbility(["admin"]),
        requestIdempotencyKey: "metadata-request",
      };
      await service.call(child.friendlyId, body, authEnvironment, options);
      await service.call(child.friendlyId, body, authEnvironment, options);
      await service.flushOperations();
      for (const target of [parent, root]) {
        const updated = await prisma.taskRun.findFirst({ where: { id: target.id } });
        expect(JSON.parse(updated!.metadata!)).toEqual({ count: 1 });
      }
      const updatedChild = await prisma.taskRun.findFirst({ where: { id: child.id } });
      expect(JSON.parse(updatedChild!.metadata!)).toEqual({ accepted: true });

      const otherEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          projectId: project.id,
          organizationId: organization.id,
          type: "DEVELOPMENT",
          slug: "other",
          apiKey: "other",
          pkApiKey: "other",
          shortcode: "other",
        },
      });
      await prisma.taskRun.updateMany({
        where: { id: parent.id },
        data: { runtimeEnvironmentId: otherEnvironment.id },
      });
      await expect(
        service.call(child.friendlyId, { parentOperations: increment }, authEnvironment, options)
      ).rejects.toMatchObject({ status: 404 });
      await service.flushOperations();
      const unchangedParent = await prisma.taskRun.findFirst({ where: { id: parent.id } });
      expect(JSON.parse(unchangedParent!.metadata!)).toEqual({ count: 1 });
    }
  );

  redisTest(
    "checks captured parent/root IDs before CAS for new run IDs and keeps tenant isolation",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions });
      const runId = `run_${generateRunOpsId()}`;
      const parentId = generateRunOpsId();
      const rootId = generateRunOpsId();
      try {
        await buffer.accept({
          runId,
          envId: "env_a",
          orgId: "org_a",
          payload: JSON.stringify({
            metadata: "{}",
            parentTaskRunId: parentId,
            rootTaskRunId: rootId,
          }),
        });
        const input = {
          runId,
          environmentId: "env_a",
          organizationId: "org_a",
          maximumSize: 1024,
          buffer,
          body: {
            metadata: { accepted: true },
            parentOperations: increment,
            rootOperations: increment,
          },
        };
        for (const scopes of [
          [`write:runs:${runId}`],
          [`write:runs:${runId}`, `write:runs:run_${parentId}`],
        ]) {
          await expect(
            applyMetadataMutationToBufferedRun({ ...input, ability: buildJwtAbility(scopes) })
          ).rejects.toMatchObject({ status: 403 });
          const entry = await buffer.getEntry(runId);
          expect(JSON.parse(entry!.payload)).toMatchObject({ metadata: "{}" });
        }
        expect(
          await applyMetadataMutationToBufferedRun({
            ...input,
            environmentId: "env_other",
            ability: buildJwtAbility(["admin"]),
          })
        ).toEqual({ kind: "not_found" });
        expect(
          await applyMetadataMutationToBufferedRun({
            ...input,
            ability: buildJwtAbility(["admin"]),
          })
        ).toMatchObject({
          kind: "applied",
          newMetadata: { accepted: true },
          parentTaskRunFriendlyId: `run_${parentId}`,
          rootTaskRunFriendlyId: `run_${rootId}`,
        });
      } finally {
        await buffer.close();
      }
    }
  );

  redisTest(
    "parent/root operations on a top-level run require only its own write scope",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions });
      const { friendlyId: runId } = RunId.generate();
      try {
        await buffer.accept({ runId, envId: "env_a", orgId: "org_a", payload: "{}" });
        expect(
          await applyMetadataMutationToBufferedRun({
            runId,
            environmentId: "env_a",
            organizationId: "org_a",
            maximumSize: 1024,
            buffer,
            body: { parentOperations: increment, rootOperations: increment },
            ability: buildJwtAbility([`write:runs:${runId}`]),
          })
        ).toMatchObject({ kind: "applied" });
      } finally {
        await buffer.close();
      }
    }
  );
});
