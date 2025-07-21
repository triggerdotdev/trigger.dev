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
    }
  );
});
