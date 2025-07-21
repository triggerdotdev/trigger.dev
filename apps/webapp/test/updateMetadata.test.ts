import { containerTest } from "@internal/testcontainers";
import { parsePacket } from "@trigger.dev/core/v3";
import { setTimeout } from "timers/promises";
import { describe } from "vitest";
import { UpdateMetadataService } from "~/services/metadata/updateMetadata.server";
import { MetadataTooLargeError } from "~/utils/packets";

vi.setConfig({ testTimeout: 30_000 }); // 30 seconds timeout

describe("UpdateMetadataService.call", () => {
  containerTest(
    "should apply operations to update the run metadata",
    async ({ prisma, redisOptions }) => {
      const service = new UpdateMetadataService({
        prisma,
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1, // 1MB
        logLevel: "debug",
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
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

      // Now we insert a row into the table
      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      const result = await service.call(taskRun.id, {
        operations: [
          {
            type: "set",
            key: "foo",
            value: "bar",
          },
          {
            type: "append",
            key: "bar",
            value: "baz",
          },
        ],
      });

      expect(result).toBeDefined();

      expect(result?.metadata).toEqual({
        foo: "bar",
        bar: ["baz"],
      });

      const updatedTaskRun = await prisma.taskRun.findUnique({
        where: {
          id: taskRun.id,
        },
      });

      const metadata = await parsePacket({
        data: updatedTaskRun?.metadata ?? undefined,
        dataType: updatedTaskRun?.metadataType ?? "application/json",
      });

      expect(metadata).toEqual({
        foo: "bar",
        bar: ["baz"],
      });

      service.stopFlushing();
    }
  );

  containerTest(
    "should throw a MetadataTooLargeError when metadata is too large and not apply the operations",
    async ({ prisma, redisOptions }) => {
      const service = new UpdateMetadataService({
        prisma,
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024, // 1KB
        logLevel: "debug",
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
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

      // Now we insert a row into the table
      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await service.call(taskRun.id, {
        operations: [
          {
            type: "append",
            key: "logs",
            value: "thisisalargemessage1",
          },
          {
            type: "append",
            key: "logs",
            value: "thisisalargemessage2",
          },
          {
            type: "append",
            key: "logs",
            value: "thisisalargemessage3",
          },
          {
            type: "append",
            key: "logs",
            value: "thisisalargemessage4",
          },
        ],
      });

      const updatedTaskRun = await prisma.taskRun.findUnique({
        where: {
          id: taskRun.id,
        },
      });

      const metadata = await parsePacket({
        data: updatedTaskRun?.metadata ?? undefined,
        dataType: updatedTaskRun?.metadataType ?? "application/json",
      });

      expect(metadata).toEqual({
        logs: [
          "thisisalargemessage1",
          "thisisalargemessage2",
          "thisisalargemessage3",
          "thisisalargemessage4",
        ],
      });

      // Now lets try and add a very large log message
      const callPromise = service.call(taskRun.id, {
        operations: [
          {
            type: "append",
            key: "logs",
            value: Array.from({ length: 1000 }, () => "anotherlogmessage").join(""),
          },
        ],
      });

      await expect(callPromise).rejects.toThrow(MetadataTooLargeError);

      const updatedTaskRun2 = await prisma.taskRun.findUnique({
        where: {
          id: taskRun.id,
        },
      });

      const parsedMetadata2 = JSON.parse(updatedTaskRun2?.metadata ?? "{}");

      expect(parsedMetadata2).toEqual({
        logs: [
          "thisisalargemessage1",
          "thisisalargemessage2",
          "thisisalargemessage3",
          "thisisalargemessage4",
        ],
      });

      // okay now lets try and add a smaller log message
      await service.call(taskRun.id, {
        operations: [
          {
            type: "append",
            key: "logs",
            value: "thisisalargemessage5",
          },
        ],
      });

      const updatedTaskRun3 = await prisma.taskRun.findUnique({
        where: {
          id: taskRun.id,
        },
      });

      const metadata3 = await parsePacket({
        data: updatedTaskRun3?.metadata ?? undefined,
        dataType: updatedTaskRun3?.metadataType ?? "application/json",
      });

      expect(metadata3).toEqual({
        logs: [
          "thisisalargemessage1",
          "thisisalargemessage2",
          "thisisalargemessage3",
          "thisisalargemessage4",
          "thisisalargemessage5",
        ],
      });

      service.stopFlushing();
    }
  );

  containerTest(
    "should apply buffered operations to update the parent run metadata",
    async ({ prisma, redisOptions }) => {
      const service = new UpdateMetadataService({
        prisma,
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1, // 1MB
        logLevel: "debug",
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
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

      // Now we insert a row into the table
      const parentTaskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1235",
          taskIdentifier: "my-child-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          parentTaskRunId: parentTaskRun.id,
        },
      });

      const result = await service.call(taskRun.id, {
        parentOperations: [
          {
            type: "set",
            key: "foo",
            value: "bar",
          },
          {
            type: "append",
            key: "bar",
            value: "baz",
          },
        ],
      });

      expect(result).toBeDefined();
      expect(result?.metadata).toEqual({});

      // Wait for the buffered operations to be applied
      await setTimeout(1000);

      const updatedParentTaskRun = await prisma.taskRun.findUnique({
        where: {
          id: parentTaskRun.id,
        },
      });

      const metadata = await parsePacket({
        data: updatedParentTaskRun?.metadata ?? undefined,
        dataType: updatedParentTaskRun?.metadataType ?? "application/json",
      });

      expect(metadata).toEqual({
        foo: "bar",
        bar: ["baz"],
      });

      service.stopFlushing();
    }
  );

  containerTest(
    "should handle applying buffered operations to update the root run metadata when the root run metadata is too large",
    async ({ prisma, redisOptions }) => {
      const service = new UpdateMetadataService({
        prisma,
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024, // 1KB
        logLevel: "debug",
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
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

      // Create a root task run
      const rootTaskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_root",
          taskIdentifier: "root-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      // Create a child task run
      const childTaskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_child",
          taskIdentifier: "child-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          rootTaskRunId: rootTaskRun.id,
        },
      });

      // Create a grandchild task run
      const grandchildTaskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_grandchild",
          taskIdentifier: "grandchild-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          parentTaskRunId: childTaskRun.id,
          rootTaskRunId: rootTaskRun.id,
        },
      });

      // Add some initial metadata to root
      const result = await service.call(grandchildTaskRun.id, {
        rootOperations: [
          {
            type: "append",
            key: "logs",
            value: "initiallog1",
          },
          {
            type: "append",
            key: "logs",
            value: "initiallog2",
          },
        ],
      });

      expect(result).toBeDefined();
      expect(result?.metadata).toEqual({});

      // Wait for the buffered operations to be applied
      await setTimeout(1000);

      const updatedRootTaskRun = await prisma.taskRun.findUnique({
        where: {
          id: rootTaskRun.id,
        },
      });

      const metadata = await parsePacket({
        data: updatedRootTaskRun?.metadata ?? undefined,
        dataType: updatedRootTaskRun?.metadataType ?? "application/json",
      });

      expect(metadata).toEqual({
        logs: ["initiallog1", "initiallog2"],
      });

      // Now try to add a very large log message to root
      await service.call(grandchildTaskRun.id, {
        rootOperations: [
          {
            type: "append",
            key: "logs",
            value: Array.from({ length: 1000 }, () => "anotherlogmessage").join(""),
          },
        ],
      });

      await setTimeout(1000);

      const updatedRootTaskRun2 = await prisma.taskRun.findUnique({
        where: {
          id: rootTaskRun.id,
        },
      });

      const metadata2 = await parsePacket({
        data: updatedRootTaskRun2?.metadata ?? undefined,
        dataType: updatedRootTaskRun2?.metadataType ?? "application/json",
      });

      // The large operation should have been dropped
      expect(metadata2).toEqual({
        logs: ["initiallog1", "initiallog2"],
      });

      // Now add a smaller log message
      await service.call(grandchildTaskRun.id, {
        rootOperations: [
          {
            type: "append",
            key: "logs",
            value: "smalllog3",
          },
        ],
      });

      await setTimeout(1000);

      const updatedRootTaskRun3 = await prisma.taskRun.findUnique({
        where: {
          id: rootTaskRun.id,
        },
      });

      const metadata3 = await parsePacket({
        data: updatedRootTaskRun3?.metadata ?? undefined,
        dataType: updatedRootTaskRun3?.metadataType ?? "application/json",
      });

      expect(metadata3).toEqual({
        logs: ["initiallog1", "initiallog2", "smalllog3"],
      });

      service.stopFlushing();
    }
  );

  containerTest(
    "should handle applying buffered operations to update the parent run metadata when the parent run metadata is too large",
    async ({ prisma, redisOptions }) => {
      const service = new UpdateMetadataService({
        prisma,
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024, // 1KB
        logLevel: "debug",
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
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

      // Now we insert a row into the table
      const parentTaskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1235",
          taskIdentifier: "my-child-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          parentTaskRunId: parentTaskRun.id,
        },
      });

      const result = await service.call(taskRun.id, {
        parentOperations: [
          {
            type: "append",
            key: "logs",
            value: "thisisalargemessage1",
          },
          {
            type: "append",
            key: "logs",
            value: "thisisalargemessage2",
          },
          {
            type: "append",
            key: "logs",
            value: "thisisalargemessage3",
          },
          {
            type: "append",
            key: "logs",
            value: "thisisalargemessage4",
          },
        ],
      });

      expect(result).toBeDefined();
      expect(result?.metadata).toEqual({});

      // Wait for the buffered operations to be applied
      await setTimeout(1000);

      const updatedParentTaskRun = await prisma.taskRun.findUnique({
        where: {
          id: parentTaskRun.id,
        },
      });

      const metadata = await parsePacket({
        data: updatedParentTaskRun?.metadata ?? undefined,
        dataType: updatedParentTaskRun?.metadataType ?? "application/json",
      });

      expect(metadata).toEqual({
        logs: [
          "thisisalargemessage1",
          "thisisalargemessage2",
          "thisisalargemessage3",
          "thisisalargemessage4",
        ],
      });

      // Now lets try and add a very large log message
      await service.call(taskRun.id, {
        parentOperations: [
          {
            type: "append",
            key: "logs",
            value: Array.from({ length: 1000 }, () => "anotherlogmessage").join(""),
          },
        ],
      });

      await setTimeout(1000);

      const updatedParentTaskRun2 = await prisma.taskRun.findUnique({
        where: {
          id: parentTaskRun.id,
        },
      });

      const metadata2 = await parsePacket({
        data: updatedParentTaskRun2?.metadata ?? undefined,
        dataType: updatedParentTaskRun2?.metadataType ?? "application/json",
      });

      expect(metadata2).toEqual({
        logs: [
          "thisisalargemessage1",
          "thisisalargemessage2",
          "thisisalargemessage3",
          "thisisalargemessage4",
        ],
      });

      // Now lets try and add a smaller log message
      await service.call(taskRun.id, {
        parentOperations: [
          {
            type: "append",
            key: "logs",
            value: "thisisalargemessage5",
          },
        ],
      });

      await setTimeout(1000);

      const updatedParentTaskRun3 = await prisma.taskRun.findUnique({
        where: {
          id: parentTaskRun.id,
        },
      });

      const metadata3 = await parsePacket({
        data: updatedParentTaskRun3?.metadata ?? undefined,
        dataType: updatedParentTaskRun3?.metadataType ?? "application/json",
      });

      expect(metadata3).toEqual({
        logs: [
          "thisisalargemessage1",
          "thisisalargemessage2",
          "thisisalargemessage3",
          "thisisalargemessage4",
          "thisisalargemessage5",
        ],
      });

      service.stopFlushing();
    }
  );

  containerTest(
    "should handle optimistic locking conflicts for buffered operations",
    async ({ prisma, redisOptions }) => {
      let onAfterReadCallCount = 0;

      const service = new UpdateMetadataService({
        prisma,
        flushIntervalMs: 100000, // Very long interval so we can control flushing
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1, // 1MB
        logLevel: "debug",
        onAfterRead: async (runId, metadataVersion) => {
          onAfterReadCallCount++;
          // Simulate concurrent update after first read
          if (onAfterReadCallCount === 1) {
            await prisma.taskRun.updateMany({
              where: { id: runId },
              data: {
                metadata: JSON.stringify({ concurrent: "update" }),
                metadataVersion: { increment: 1 },
              },
            });
          }
        },
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
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

      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      // Buffer some operations
      await service.call(taskRun.id, {
        parentOperations: [
          {
            type: "set",
            key: "buffered",
            value: "value1",
          },
        ],
      });

      // Manually trigger flush
      await service.flushOperations();

      // The first attempt should fail due to optimistic lock
      // But it should retry and succeed
      expect(onAfterReadCallCount).toBeGreaterThanOrEqual(2);

      const finalTaskRun = await prisma.taskRun.findUnique({
        where: { id: taskRun.id },
      });

      const metadata = await parsePacket({
        data: finalTaskRun?.metadata ?? undefined,
        dataType: finalTaskRun?.metadataType ?? "application/json",
      });

      // Should have both the concurrent update and the buffered operation
      expect(metadata).toEqual({
        concurrent: "update",
        buffered: "value1",
      });

      service.stopFlushing();
    }
  );

  containerTest(
    "should handle optimistic locking conflicts for immediate operations",
    async ({ prisma, redisOptions }) => {
      let onAfterReadCallCount = 0;

      const service = new UpdateMetadataService({
        prisma,
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1, // 1MB
        logLevel: "debug",
        onAfterRead: async (runId, metadataVersion) => {
          onAfterReadCallCount++;
          // Simulate concurrent update after each read (up to 3 times)
          if (onAfterReadCallCount <= 3) {
            await prisma.taskRun.updateMany({
              where: { id: runId },
              data: {
                metadata: JSON.stringify({ concurrent: `update${onAfterReadCallCount}` }),
                metadataVersion: { increment: 1 },
              },
            });
          }
        },
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
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

      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      // Try immediate operations - should retry 3 times then buffer
      const result = await service.call(taskRun.id, {
        operations: [
          {
            type: "set",
            key: "immediate",
            value: "value1",
          },
        ],
      });

      // Should have retried 3 times
      expect(onAfterReadCallCount).toBe(4); // Initial read + 3 retries

      // The result should optimistically return the applied operations
      expect(result?.metadata).toEqual({
        concurrent: "update3",
        immediate: "value1",
      });

      // Wait for buffered operations to be flushed
      await setTimeout(1000);

      const finalTaskRun = await prisma.taskRun.findUnique({
        where: { id: taskRun.id },
      });

      const metadata = await parsePacket({
        data: finalTaskRun?.metadata ?? undefined,
        dataType: finalTaskRun?.metadataType ?? "application/json",
      });

      // Should eventually have the immediate operation applied
      expect(metadata).toEqual({
        concurrent: "update3",
        immediate: "value1",
      });

      service.stopFlushing();
    }
  );

  containerTest(
    "should cull set operations keeping only the latest value for each key",
    async ({ prisma, redisOptions }) => {
      const service = new UpdateMetadataService({
        prisma,
        flushIntervalMs: 100000, // Very long interval so we can control flushing
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1, // 1MB
        logLevel: "debug",
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
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

      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      // Buffer multiple set operations for the same key
      await service.call(taskRun.id, {
        parentOperations: [
          {
            type: "set",
            key: "status",
            value: "starting",
          },
        ],
      });

      await service.call(taskRun.id, {
        parentOperations: [
          {
            type: "set",
            key: "status",
            value: "running",
          },
          {
            type: "set",
            key: "progress",
            value: 50,
          },
        ],
      });

      await service.call(taskRun.id, {
        parentOperations: [
          {
            type: "set",
            key: "status",
            value: "completed",
          },
          {
            type: "set",
            key: "progress",
            value: 100,
          },
          {
            type: "append",
            key: "logs",
            value: "Task started",
          },
          {
            type: "append",
            key: "logs",
            value: "Task completed",
          },
        ],
      });

      // Manually trigger flush
      await service.flushOperations();

      const finalTaskRun = await prisma.taskRun.findUnique({
        where: { id: taskRun.id },
      });

      const metadata = await parsePacket({
        data: finalTaskRun?.metadata ?? undefined,
        dataType: finalTaskRun?.metadataType ?? "application/json",
      });

      // Should only have the latest set values, but all append operations
      expect(metadata).toEqual({
        status: "completed",
        progress: 100,
        logs: ["Task started", "Task completed"],
      });

      service.stopFlushing();
    }
  );

  containerTest(
    "should not update run metadata if completed more than 1 hour ago",
    async ({ prisma, redisOptions }) => {
      const service = new UpdateMetadataService({
        prisma,
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1, // 1MB
        logLevel: "debug",
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
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

      // Create a task run completed more than 1 hour ago
      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
        },
      });

      // Try to update metadata - should throw
      await expect(
        service.call(taskRun.id, {
          operations: [
            {
              type: "set",
              key: "status",
              value: "updated",
            },
          ],
        })
      ).rejects.toThrow("Cannot update metadata for a completed run");

      service.stopFlushing();
    }
  );

  containerTest(
    "should allow updating run metadata if completed within 1 hour",
    async ({ prisma, redisOptions }) => {
      const service = new UpdateMetadataService({
        prisma,
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1, // 1MB
        logLevel: "debug",
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
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

      // Create a task run completed 30 minutes ago
      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          completedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 minutes ago
        },
      });

      // Should be able to update metadata
      const result = await service.call(taskRun.id, {
        operations: [
          {
            type: "set",
            key: "status",
            value: "updated",
          },
        ],
      });

      expect(result?.metadata).toEqual({
        status: "updated",
      });

      service.stopFlushing();
    }
  );
});
