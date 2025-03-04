import { containerWithElectricAndRedisTest } from "@internal/testcontainers";
import { expect, describe } from "vitest";
import { RealtimeClient } from "../app/services/realtimeClient.server.js";
import Redis from "ioredis";

describe.skipIf(process.env.GITHUB_ACTIONS)("RealtimeClient", () => {
  containerWithElectricAndRedisTest(
    "Should only track concurrency for live requests",
    { timeout: 30_000 },
    async ({ redisOptions, electricOrigin, prisma }) => {
      const redis = new Redis(redisOptions);

      const client = new RealtimeClient({
        electricOrigin,
        keyPrefix: "test:realtime",
        redis: {
          host: redis.options.host,
          port: redis.options.port,
          tlsDisabled: true,
        },
        expiryTimeInSeconds: 5,
        cachedLimitProvider: {
          async getCachedLimit() {
            return 1;
          },
        },
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test-org",
          slug: "test-org",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-project",
          slug: "test-project",
          organizationId: organization.id,
          externalRef: "test-project",
        },
      });

      const environment = await prisma.runtimeEnvironment.create({
        data: {
          projectId: project.id,
          organizationId: organization.id,
          slug: "test",
          type: "DEVELOPMENT",
          shortcode: "1234",
          apiKey: "tr_dev_1234",
          pkApiKey: "pk_test_1234",
        },
      });

      const run = await prisma.taskRun.create({
        data: {
          taskIdentifier: "test-task",
          friendlyId: "run_1234",
          payload: "{}",
          payloadType: "application/json",
          traceId: "trace_1234",
          spanId: "span_1234",
          queue: "test-queue",
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        },
      });

      const initialResponsePromise = client.streamRun(
        "http://localhost:3000?offset=-1",
        environment,
        run.id,
        "0.8.1"
      );

      const initializeResponsePromise2 = new Promise<Response>((resolve) => {
        setTimeout(async () => {
          const response = await client.streamRun(
            "http://localhost:3000?offset=-1",
            environment,
            run.id,
            "0.8.1"
          );

          resolve(response);
        }, 1);
      });

      const [response, response2] = await Promise.all([
        initialResponsePromise,
        initializeResponsePromise2,
      ]);

      const headers = Object.fromEntries(response.headers.entries());

      const shapeId = headers["electric-handle"];
      const chunkOffset = headers["electric-offset"];

      expect(response.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(shapeId).toBeDefined();
      expect(chunkOffset).toBe("0_0");

      // Okay, now we will do two live requests, and the second one should fail because of the concurrency limit
      const liveResponsePromise = client.streamRun(
        `http://localhost:3000?offset=0_0&live=true&handle=${shapeId}`,
        environment,
        run.id,
        "0.8.1"
      );

      const liveResponsePromise2 = new Promise<Response>((resolve) => {
        setTimeout(async () => {
          const response = await client.streamRun(
            `http://localhost:3000?offset=0_0&live=true&handle=${shapeId}`,
            environment,
            run.id,
            "0.8.1"
          );

          resolve(response);
        }, 1);
      });

      const updateRunAfter1SecondPromise = new Promise<void>((resolve) => {
        setTimeout(async () => {
          await prisma.taskRun.update({
            where: { id: run.id },
            data: { metadata: "{}" },
          });

          resolve();
        }, 1000);
      });

      const [liveResponse, liveResponse2] = await Promise.all([
        liveResponsePromise,
        liveResponsePromise2,
        updateRunAfter1SecondPromise,
      ]);

      expect(liveResponse.status).toBe(200);
      expect(liveResponse2.status).toBe(429);
    }
  );

  containerWithElectricAndRedisTest(
    "Should support subscribing to a run tag",
    { timeout: 30_000 },
    async ({ redisOptions, electricOrigin, prisma }) => {
      const redis = new Redis(redisOptions);

      const client = new RealtimeClient({
        electricOrigin,
        keyPrefix: "test:realtime",
        redis: {
          host: redis.options.host,
          port: redis.options.port,
          tlsDisabled: true,
        },
        expiryTimeInSeconds: 5,
        cachedLimitProvider: {
          async getCachedLimit() {
            return 1;
          },
        },
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test-org",
          slug: "test-org",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-project",
          slug: "test-project",
          organizationId: organization.id,
          externalRef: "test-project",
        },
      });

      const environment = await prisma.runtimeEnvironment.create({
        data: {
          projectId: project.id,
          organizationId: organization.id,
          slug: "test",
          type: "DEVELOPMENT",
          shortcode: "1234",
          apiKey: "tr_dev_1234",
          pkApiKey: "pk_test_1234",
        },
      });

      const run = await prisma.taskRun.create({
        data: {
          taskIdentifier: "test-task",
          friendlyId: "run_1234",
          payload: "{}",
          payloadType: "application/json",
          traceId: "trace_1234",
          spanId: "span_1234",
          queue: "test-queue",
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          runTags: ["test:tag:1234", "test:tag:5678"],
        },
      });

      const response = await client.streamRuns(
        "http://localhost:3000?offset=-1",
        environment,
        {
          tags: ["test:tag:1234"],
        },
        "0.8.1"
      );

      const headers = Object.fromEntries(response.headers.entries());

      const shapeId = headers["electric-handle"];
      const chunkOffset = headers["electric-offset"];

      expect(response.status).toBe(200);
      expect(shapeId).toBeDefined();
      expect(chunkOffset).toBe("0_0");
    }
  );

  containerWithElectricAndRedisTest(
    "Should adapt for older client versions",
    { timeout: 30_000 },
    async ({ redisOptions, electricOrigin, prisma }) => {
      const redis = new Redis(redisOptions);

      const client = new RealtimeClient({
        electricOrigin,
        keyPrefix: "test:realtime",
        redis: {
          host: redis.options.host,
          port: redis.options.port,
          tlsDisabled: true,
        },
        expiryTimeInSeconds: 5,
        cachedLimitProvider: {
          async getCachedLimit() {
            return 1;
          },
        },
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test-org",
          slug: "test-org",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-project",
          slug: "test-project",
          organizationId: organization.id,
          externalRef: "test-project",
        },
      });

      const environment = await prisma.runtimeEnvironment.create({
        data: {
          projectId: project.id,
          organizationId: organization.id,
          slug: "test",
          type: "DEVELOPMENT",
          shortcode: "1234",
          apiKey: "tr_dev_1234",
          pkApiKey: "pk_test_1234",
        },
      });

      const run = await prisma.taskRun.create({
        data: {
          taskIdentifier: "test-task",
          friendlyId: "run_1234",
          payload: "{}",
          payloadType: "application/json",
          traceId: "trace_1234",
          spanId: "span_1234",
          queue: "test-queue",
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        },
      });

      const initialResponsePromise = client.streamRun(
        "http://localhost:3000?offset=-1",
        environment,
        run.id
      );

      const initializeResponsePromise2 = new Promise<Response>((resolve) => {
        setTimeout(async () => {
          const response = await client.streamRun(
            "http://localhost:3000?offset=-1",
            environment,
            run.id,
            "0.8.1"
          );

          resolve(response);
        }, 1);
      });

      const [response, response2] = await Promise.all([
        initialResponsePromise,
        initializeResponsePromise2,
      ]);

      const headers = Object.fromEntries(response.headers.entries());

      const shapeId = headers["electric-shape-id"];
      const chunkOffset = headers["electric-chunk-last-offset"];

      expect(response.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(shapeId).toBeDefined();
      expect(chunkOffset).toBe("0_0");

      // Okay, now we will do two live requests, and the second one should fail because of the concurrency limit
      const liveResponsePromise = client.streamRun(
        `http://localhost:3000?offset=0_0&live=true&shape_id=${shapeId}`,
        environment,
        run.id
      );

      const liveResponsePromise2 = new Promise<Response>((resolve) => {
        setTimeout(async () => {
          const response = await client.streamRun(
            `http://localhost:3000?offset=0_0&live=true&shape_id=${shapeId}`,
            environment,
            run.id
          );

          resolve(response);
        }, 1);
      });

      const updateRunAfter1SecondPromise = new Promise<void>((resolve) => {
        setTimeout(async () => {
          await prisma.taskRun.update({
            where: { id: run.id },
            data: { metadata: "{}" },
          });

          resolve();
        }, 1000);
      });

      const [liveResponse, liveResponse2] = await Promise.all([
        liveResponsePromise,
        liveResponsePromise2,
        updateRunAfter1SecondPromise,
      ]);

      expect(liveResponse.status).toBe(200);
      expect(liveResponse2.status).toBe(429);
    }
  );
});
