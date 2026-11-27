import { postgresTest } from "@internal/testcontainers";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient, TaskRunStatus } from "@trigger.dev/database";
import { beforeEach, describe, expect, vi } from "vitest";

const dbHolder = vi.hoisted(() => ({ client: undefined as PrismaClient | undefined }));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (!dbHolder.client) throw new Error("dbHolder.client not set for this test");
        return (dbHolder.client as any)[prop];
      },
    }
  );
  return { prisma: proxy, $replica: proxy };
});

import { CURRENT_API_VERSION } from "~/api/versions";
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";

vi.setConfig({ testTimeout: 60_000 });

beforeEach(() => {
  dbHolder.client = undefined;
});

type Case = {
  name: string;
  status: TaskRunStatus;
  payload: string;
  payloadType: string;
  output: string | null;
  outputType: string;
  expectPayload: unknown;
  expectOutput: unknown;
};

const cases: Case[] = [
  {
    name: "payload text/plain empty string is returned as empty string",
    status: "PENDING",
    payload: "",
    payloadType: "text/plain",
    output: null,
    outputType: "application/json",
    expectPayload: "",
    expectOutput: undefined,
  },
  {
    name: "payload application/json empty (omitted payload) stays absent",
    status: "PENDING",
    payload: "",
    payloadType: "application/json",
    output: null,
    outputType: "application/json",
    expectPayload: undefined,
    expectOutput: undefined,
  },
  {
    name: "completed run output text/plain empty string is returned as empty string",
    status: "COMPLETED_SUCCESSFULLY",
    payload: "{}",
    payloadType: "application/json",
    output: "",
    outputType: "text/plain",
    expectPayload: {},
    expectOutput: "",
  },
  {
    name: "completed run with null output text/plain stays absent",
    status: "COMPLETED_SUCCESSFULLY",
    payload: "{}",
    payloadType: "application/json",
    output: null,
    outputType: "text/plain",
    expectPayload: {},
    expectOutput: undefined,
  },
  {
    name: "non-completed run output text/plain empty string stays absent",
    status: "EXECUTING",
    payload: "{}",
    payloadType: "application/json",
    output: "",
    outputType: "text/plain",
    expectPayload: {},
    expectOutput: undefined,
  },
];

describe("ApiRetrieveRunPresenter empty payload/output", () => {
  for (const c of cases) {
    postgresTest(c.name, async ({ prisma }) => {
      dbHolder.client = prisma;

      const organization = await prisma.organization.create({
        data: { title: "t", slug: "t" },
      });
      const project = await prisma.project.create({
        data: { name: "t", slug: "t", organizationId: organization.id, externalRef: "t" },
      });
      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "t",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "tr_dev_t",
          pkApiKey: "pk_dev_t",
          shortcode: "short-t",
        },
      });

      const id = generateRunOpsId();
      await prisma.taskRun.create({
        data: {
          id,
          friendlyId: `run_${id}`,
          taskIdentifier: "my-task",
          payload: c.payload,
          payloadType: c.payloadType,
          output: c.output,
          outputType: c.outputType,
          status: c.status,
          traceId: `trace_${id}`,
          spanId: `span_${id}`,
          queue: "task/my-task",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      const env = {
        id: runtimeEnvironment.id,
        slug: runtimeEnvironment.slug,
        organizationId: organization.id,
        organization: { id: organization.id },
        project: { id: project.id, externalRef: project.externalRef },
      } as unknown as AuthenticatedEnvironment;

      const found = await ApiRetrieveRunPresenter.findRun(`run_${id}`, env);
      const result = await new ApiRetrieveRunPresenter(CURRENT_API_VERSION).call(found!, env);

      expect(result!.payload).toEqual(c.expectPayload);
      expect(result!.output).toEqual(c.expectOutput);
    });
  }
});
