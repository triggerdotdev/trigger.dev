import { logger, schemaTask, task, tasks } from "@trigger.dev/sdk";
import { z } from "zod/v3";

export const referentialPayloadParentTask = task({
  id: "referential-payload-parent",
  run: async (payload: any) => {
    // Shared objects
    const workflowData = {
      id: "workflow-123",
      formName: "Contact Form",
    };

    const response = [
      {
        id: "q1_name",
        answer: "John Doe",
      },
      {
        id: "q2_consent",
        answer: "yes",
        leadAttribute: undefined, // Will be marked in meta
      },
    ];

    const personAttributes = {
      ip: "192.168.1.1",
      visitedForm: 1,
    };

    // Main object with shared references
    const originalObject = {
      workflowData: workflowData, // Root reference
      workflowContext: {
        leadId: undefined, // Will be marked in meta
        workflowJob: {
          workflowData: workflowData, // Same reference as root
          createdAt: new Date("2025-08-19T12:13:42.260Z"), // Date object
        },
        responseData: {
          personAttributes: personAttributes, // Same reference as root
        },
        response: response, // Same reference as root
      },
      personAttributes: personAttributes, // Root reference
      response: response, // Root reference
      jobArgs: {
        response: response, // Same reference as root
        args: workflowData, // Same reference as root
      },
    };

    await tasks.triggerAndWait<typeof referentialPayloadChildTask>(
      "referential-payload-child",
      originalObject
    );

    return {
      message: "Hello, world!",
    };
  },
});

// Define the circular schema using z.lazy() for the recursive reference
const WorkflowDataSchema = z.object({
  id: z.string(),
  formName: z.string(),
});

const ResponseItemSchema = z.object({
  id: z.string(),
  answer: z.string(),
  leadAttribute: z.undefined().optional(),
});

const PersonAttributesSchema = z.object({
  ip: z.string(),
  visitedForm: z.number(),
});

const OriginalObjectSchema = z.object({
  workflowData: WorkflowDataSchema,
  workflowContext: z.object({
    leadId: z.undefined(),
    workflowJob: z.object({
      workflowData: WorkflowDataSchema, // Same reference
      createdAt: z.date(),
    }),
    responseData: z.object({
      personAttributes: PersonAttributesSchema, // Same reference
    }),
    response: z.array(ResponseItemSchema), // Same reference
  }),
  personAttributes: PersonAttributesSchema, // Root reference
  response: z.array(ResponseItemSchema), // Root reference
  jobArgs: z.object({
    response: z.array(ResponseItemSchema), // Same reference
    args: WorkflowDataSchema, // Same reference
  }),
});

export const referentialPayloadChildTask = schemaTask({
  id: "referential-payload-child",
  schema: OriginalObjectSchema,
  run: async (payload) => {
    logger.info("Received circular payload", { payload });

    return {
      message: "Hello, world!",
    };
  },
});

export const circularReferenceParentTask = task({
  id: "circular-reference-parent",
  run: async (payload: any) => {
    const user = {
      name: "Alice",
      details: {
        age: 30,
        email: "alice@example.com",
      },
    };
    // @ts-expect-error - This is a circular reference
    user.details.user = user;

    await tasks.triggerAndWait<typeof circularReferenceChildTask>("circular-reference-child", {
      // @ts-expect-error - This is a circular reference
      user,
    });
  },
});

type CircularReferencePayload = {
  user: {
    name: string;
    details: {
      age: number;
      email: string;
      user: CircularReferencePayload;
    };
  };
};

export const circularReferenceChildTask = task({
  id: "circular-reference-child",
  run: async (payload: CircularReferencePayload) => {
    logger.info("Received circular payload", { payload });
  },
});
