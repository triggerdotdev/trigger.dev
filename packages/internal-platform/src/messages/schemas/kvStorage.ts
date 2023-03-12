import {
  KVDeleteSchema,
  KVGetSchema,
  KVSetSchema,
} from "@trigger.dev/common-schemas";
import { z } from "zod";
import {
  WorkflowRunEventPropertiesSchema,
  WorkflowSendRunEventPropertiesSchema,
} from "../sharedSchemas";

export const commandResponses = {
  RESOLVE_KV_GET: {
    data: z.object({
      key: z.string(),
      operation: z.object({
        key: z.string(),
        namespace: z.string(),
        output: z.any(),
      }),
    }),
    properties: WorkflowRunEventPropertiesSchema,
  },
  RESOLVE_KV_SET: {
    data: z.object({
      key: z.string(),
      operation: z.object({
        key: z.string(),
        namespace: z.string(),
      }),
    }),
    properties: WorkflowRunEventPropertiesSchema,
  },
  RESOLVE_KV_DELETE: {
    data: z.object({
      key: z.string(),
      operation: z.object({
        key: z.string(),
        namespace: z.string(),
      }),
    }),
    properties: WorkflowRunEventPropertiesSchema,
  },
};

export const commands = {
  SEND_KV_GET: {
    data: z.object({
      key: z.string(),
      get: KVGetSchema,
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
  SEND_KV_SET: {
    data: z.object({
      key: z.string(),
      set: KVSetSchema,
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
  SEND_KV_DELETE: {
    data: z.object({
      key: z.string(),
      delete: KVDeleteSchema,
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
};
