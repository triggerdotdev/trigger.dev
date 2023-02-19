import { EndpointSpecParameter } from "core/endpoint/types";
import {
  makeArraySchema,
  makeBooleanSchema,
  makeNumberSchema,
  makeObjectSchema,
  makeOneOf,
  makeStringSchema,
} from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";

export const ErrorSchema = makeObjectSchema("Error", {
  requiredProperties: {
    errors: makeArraySchema(
      "Errors",
      makeObjectSchema("Error", {
        requiredProperties: {
          field: makeStringSchema("Field"),
          message: makeStringSchema("Message"),
        },
        optionalProperties: {
          help: makeStringSchema("Help"),
        },
      })
    ),
  },
});

export const fromEmailObjectSchema: JSONSchema = {
  title: "From Email Object",
  type: "object",
  properties: {
    email: {
      type: "string",
      format: "email",
      description:
        "The 'From' email address used to deliver the message. This address should be a verified sender in your Twilio SendGrid account.",
    },
    name: {
      type: "string",
      description: "A name or title associated with the sending email address.",
    },
  },
  required: ["email"],
  example: {
    email: "jane_doe@example.com",
    name: "Jane Doe",
  },
};

export const ToEmailArraySchema: JSONSchema = {
  title: "To Email Array",
  type: "array",
  items: {
    type: "object",
    properties: {
      email: {
        type: "string",
        format: "email",
        description: "The intended recipient's email address.",
      },
      name: {
        type: "string",
        description: "The intended recipient's name.",
      },
    },
    required: ["email"],
  },
  example: [
    {
      email: "john_doe@example.com",
      name: "John Doe",
    },
  ],
};

export const CCBCCEmailObjectSchema: JSONSchema = {
  title: "CC BCC Email Object",
  type: "object",
  properties: {
    email: {
      type: "string",
      format: "email",
      description: "The intended recipient's email address.",
    },
    name: {
      type: "string",
      description: "The intended recipient's name.",
    },
  },
  required: ["email"],
  example: {
    email: "jane_doe@example.com",
    name: "Jane Doe",
  },
};

export const ReplyToEmailObjectSchema: JSONSchema = {
  title: "Reply_to Email Object",
  type: "object",
  properties: {
    email: {
      type: "string",
      format: "email",
      description:
        "The email address where any replies or bounces will be returned.",
    },
    name: {
      type: "string",
      description:
        "A name or title associated with the `reply_to` email address.",
    },
  },
  required: ["email"],
  example: {
    email: "jane_doe@example.com",
    name: "Jane Doe",
  },
};
