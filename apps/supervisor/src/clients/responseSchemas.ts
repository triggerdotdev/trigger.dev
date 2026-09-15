import type { AnyZodSchema } from "@trigger.dev/core/v3";
import {
  WorkerApiConnectResponseBody,
  WorkerApiContinueRunExecutionRequestBody,
  WorkerApiDequeueResponseBody,
  WorkerApiHeartbeatResponseBody,
  WorkerApiRunAttemptCompleteResponseBody,
  WorkerApiRunHeartbeatResponseBody,
  WorkerApiRunLatestSnapshotResponseBody,
  WorkerApiRunSnapshotsSinceResponseBody,
  WorkerApiSuspendRunResponseBody,
} from "@trigger.dev/core/v3/workers";
import { z } from "zod";

const responseSchemas = [
  WorkerApiConnectResponseBody,
  WorkerApiContinueRunExecutionRequestBody,
  WorkerApiDequeueResponseBody,
  WorkerApiHeartbeatResponseBody,
  WorkerApiRunAttemptCompleteResponseBody,
  WorkerApiRunHeartbeatResponseBody,
  WorkerApiRunLatestSnapshotResponseBody,
  WorkerApiRunSnapshotsSinceResponseBody,
  WorkerApiSuspendRunResponseBody,
];

const compiledSchemas = new Map<AnyZodSchema, AnyZodSchema>(
  responseSchemas.map((schema) => [schema, z.compile(schema)])
);

export function resolveResponseSchema<T extends AnyZodSchema>(schema: T): T {
  return (compiledSchemas.get(schema) as T | undefined) ?? schema;
}
