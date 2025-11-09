/**
 * Proto loader for gRPC definitions.
 *
 * Loads worker.proto file and provides typed gRPC service definitions.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to proto file (relative to this file)
// In dist/esm/ipc/, we need to go up 4 levels to reach packages/, then into core/proto/
// This assumes the standard monorepo structure:
//   packages/cli-v3/dist/esm/ipc/protoLoader.js
//   packages/core/proto/worker.proto
const PROTO_PATH = join(__dirname, '../../../../core/proto/worker.proto');

// Validate proto file exists
if (!existsSync(PROTO_PATH)) {
  throw new Error(
    `Proto file not found at ${PROTO_PATH}. ` +
    `This likely means the directory structure has changed. ` +
    `Expected path: packages/core/proto/worker.proto relative to packages/cli-v3/dist/esm/ipc/`
  );
}

// Proto loader options
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

// Load proto definition
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;

// Export the service definition
export const workerProto = protoDescriptor.trigger.worker.v1;

// Type definitions for messages (matching Python Pydantic schemas)
export interface TaskInfo {
  id: string;
  file_path: string;
}

export interface RunInfo {
  id: string;
  payload: string;  // JSON-serialized
  payload_type: string;
  tags: string[];
  is_test: boolean;
}

export interface AttemptInfo {
  id: string;
  number: number;
  started_at: string;
}

export interface TaskRunExecution {
  task: TaskInfo;
  run: RunInfo;
  attempt: AttemptInfo;
  batch?: { id: string };
  queue?: { id: string; name: string };
  organization?: { id: string; slug: string; name: string };
  project?: { id: string; ref: string; slug: string; name: string };
  environment?: { id: string; slug: string; type: string };
  deployment?: { id: string; short_code: string; version: string };
}

export interface TaskRunExecutionUsage {
  duration_ms: number;
}

export interface TaskRunBuiltInError {
  name: string;
  message: string;
  stack_trace: string;
}

export interface TaskRunInternalError {
  code: string;
  message: string;
  stack_trace: string;
}

export interface TaskRunStringError {
  raw: string;
}

export interface TaskRunError {
  error?: {
    built_in_error?: TaskRunBuiltInError;
    internal_error?: TaskRunInternalError;
    string_error?: TaskRunStringError;
  };
}

export interface TaskRunSuccessfulExecutionResult {
  id: string;
  output?: string;
  output_type: string;
  usage?: TaskRunExecutionUsage;
  task_identifier?: string;
}

export interface TaskRunFailedExecutionResult {
  id: string;
  error: TaskRunError;
  retry?: { timestamp: number; delay: number };
  skipped_retrying?: boolean;
  usage?: TaskRunExecutionUsage;
  task_identifier?: string;
}

// Worker → Coordinator Messages
export interface TaskRunCompletedMessage {
  type: string;
  version: string;
  completion: TaskRunSuccessfulExecutionResult;
}

export interface TaskRunFailedMessage {
  type: string;
  version: string;
  completion: TaskRunFailedExecutionResult;
}

export interface TaskHeartbeatMessage {
  type: string;
  version: string;
  id: string;
}

export interface TaskMetadata {
  fields: Record<string, string>;
}

export interface IndexTasksCompleteMessage {
  type: string;
  version: string;
  tasks: TaskMetadata[];
}

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LogMessage {
  type: string;
  version: string;
  level: LogLevel;
  message: string;
  logger: string;
  timestamp: string;
  exception?: string;
}

export interface WorkerMessage {
  task_run_completed?: TaskRunCompletedMessage;
  task_run_failed?: TaskRunFailedMessage;
  task_heartbeat?: TaskHeartbeatMessage;
  index_tasks_complete?: IndexTasksCompleteMessage;
  log?: LogMessage;
}

// Coordinator → Worker Messages
export interface ExecuteTaskRunMessage {
  type: string;
  version: string;
  execution: TaskRunExecution;
}

export interface CancelMessage {
  type: string;
  version: string;
}

export interface FlushMessage {
  type: string;
  version: string;
}

export interface CoordinatorMessage {
  execute_task_run?: ExecuteTaskRunMessage;
  cancel?: CancelMessage;
  flush?: FlushMessage;
}

// Service types
export type WorkerServiceClient = grpc.Client & {
  Connect: grpc.ClientDuplexStream<WorkerMessage, CoordinatorMessage>;
};

export type WorkerServiceServer = grpc.Server & {
  addService(
    service: typeof workerProto.WorkerService.service,
    implementation: {
      Connect: grpc.handleBidiStreamingCall<WorkerMessage, CoordinatorMessage>;
    }
  ): void;
};
