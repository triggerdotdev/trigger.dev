import {
  makeArraySchema,
  makeObjectSchema,
  makeStringSchema,
} from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";

export const ErrorSchema = makeObjectSchema("Error", {
  requiredProperties: {
    errors: makeArraySchema(
      "Errors",
      makeObjectSchema("Error", {
        requiredProperties: {
          message: makeStringSchema("Message"),
        },
        optionalProperties: {
          field: makeStringSchema("Field"),
          help: makeStringSchema("Help"),
          error_id: makeStringSchema("Error ID"),
          parameter: makeStringSchema("Parameter"),
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

export const ContactRequestSchema: JSONSchema = {
  title: "contact-request",
  type: "object",
  properties: {
    address_line_1: {
      type: "string",
      description: "The first line of the address.",
      maxLength: 100,
    },
    address_line_2: {
      type: "string",
      description: "An optional second line for the address.",
      maxLength: 100,
    },
    alternate_emails: {
      type: "array",
      description: "Additional emails associated with the contact.",
      minItems: 0,
      maxItems: 5,
      items: {
        type: "string",
        maxLength: 254,
      },
    },
    city: {
      type: "string",
      description: "The contact's city.",
      maxLength: 60,
    },
    country: {
      type: "string",
      description:
        "The contact's country. Can be a full name or an abbreviation.",
      maxLength: 50,
    },
    email: {
      type: "string",
      description:
        "The contact's primary email. This is required to be a valid email.",
      maxLength: 254,
    },
    first_name: {
      type: "string",
      description: "The contact's personal name.",
      maxLength: 50,
    },
    last_name: {
      type: "string",
      description: "The contact's family name.",
      maxLength: 50,
    },
    postal_code: {
      type: "string",
      description: "The contact's ZIP code or other postal code.",
    },
    state_province_region: {
      type: "string",
      description: "The contact's state, province, or region.",
      maxLength: 50,
    },
    custom_fields: {
      $ref: "#/components/schemas/custom-fields-by-id",
    },
  },
  required: ["email"],
};
