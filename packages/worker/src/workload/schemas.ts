import { z } from "zod";
import {
  WorkerApiRunHeartbeatRequestBody,
  WorkerApiHeartbeatResponseBody,
  WorkerApiRunAttemptCompleteRequestBody,
  WorkerApiRunAttemptCompleteResponseBody,
  WorkerApiRunAttemptStartRequestBody,
  WorkerApiRunAttemptStartResponseBody,
  WorkerApiRunLatestSnapshotResponseBody,
  WorkerApiDequeueFromVersionResponseBody,
  WorkerApiWaitForDurationRequestBody,
  WorkerApiWaitForDurationResponseBody,
} from "../supervisor/schemas.js";

export const WorkloadHeartbeatRequestBody = WorkerApiRunHeartbeatRequestBody;
export type WorkloadHeartbeatRequestBody = z.infer<typeof WorkloadHeartbeatRequestBody>;

export const WorkloadHeartbeatResponseBody = WorkerApiHeartbeatResponseBody;
export type WorkloadHeartbeatResponseBody = z.infer<typeof WorkloadHeartbeatResponseBody>;

export const WorkloadRunAttemptCompleteRequestBody = WorkerApiRunAttemptCompleteRequestBody;
export type WorkloadRunAttemptCompleteRequestBody = z.infer<
  typeof WorkloadRunAttemptCompleteRequestBody
>;

export const WorkloadRunAttemptCompleteResponseBody = WorkerApiRunAttemptCompleteResponseBody;
export type WorkloadRunAttemptCompleteResponseBody = z.infer<
  typeof WorkloadRunAttemptCompleteResponseBody
>;

export const WorkloadRunAttemptStartRequestBody = WorkerApiRunAttemptStartRequestBody;
export type WorkloadRunAttemptStartRequestBody = z.infer<typeof WorkloadRunAttemptStartRequestBody>;

export const WorkloadRunAttemptStartResponseBody = WorkerApiRunAttemptStartResponseBody;
export type WorkloadRunAttemptStartResponseBody = z.infer<
  typeof WorkloadRunAttemptStartResponseBody
>;

export const WorkloadRunLatestSnapshotResponseBody = WorkerApiRunLatestSnapshotResponseBody;
export type WorkloadRunLatestSnapshotResponseBody = z.infer<
  typeof WorkloadRunLatestSnapshotResponseBody
>;

export const WorkloadDequeueFromVersionResponseBody = WorkerApiDequeueFromVersionResponseBody;
export type WorkloadDequeueFromVersionResponseBody = z.infer<
  typeof WorkloadDequeueFromVersionResponseBody
>;

export const WorkloadWaitForDurationRequestBody = WorkerApiWaitForDurationRequestBody;
export type WorkloadWaitForDurationRequestBody = z.infer<typeof WorkloadWaitForDurationRequestBody>;

export const WorkloadWaitForDurationResponseBody = WorkerApiWaitForDurationResponseBody;
export type WorkloadWaitForDurationResponseBody = z.infer<
  typeof WorkloadWaitForDurationResponseBody
>;
