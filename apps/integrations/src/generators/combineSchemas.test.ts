import { EndpointSpec } from "core/endpoint/types";
import { JSONSchema } from "core/schemas/types";
import { expect, test } from "vitest";
import { createInputSchema } from "./combineSchemas";

test("create input schema when only a body schema", async () => {
  try {
    const schema: JSONSchema = {
      type: "object",
      required: ["channel"],
      properties: {
        as_user: {
          type: "string",
          description:
            "Pass true to post the message as the authed user, instead of as a bot. Defaults to false. See [authorship](#authorship) below.",
        },
        attachments: {
          type: "string",
          description:
            "A JSON-based array of structured attachments, presented as a URL-encoded string.",
        },
        channel: {
          type: "string",
          description:
            "Channel, private group, or IM channel to send message to. Can be an encoded ID, or a name. See [below](#channels) for more details.",
        },
      },
    };

    const inputSchema = createInputSchema({ body: schema });
    expect(inputSchema).toEqual(schema);
  } catch (e: any) {
    console.error(JSON.stringify(e.errors, null, 2));
    expect(e).toEqual(null);
  }
});

test("combine input body and parameters into a schema", async () => {
  try {
    const bodySchema: JSONSchema = {
      type: "object",
      required: ["channel"],
      properties: {
        as_user: {
          type: "string",
          description:
            "Pass true to post the message as the authed user, instead of as a bot. Defaults to false. See [authorship](#authorship) below.",
        },
        attachments: {
          type: "string",
          description:
            "A JSON-based array of structured attachments, presented as a URL-encoded string.",
        },
        channel: {
          type: "string",
          description:
            "Channel, private group, or IM channel to send message to. Can be an encoded ID, or a name. See [below](#channels) for more details.",
        },
      },
    };
    const parameters: EndpointSpec["parameters"] = [
      {
        name: "limit",
        description: "The maximum number of items to return.",
        in: "path",
        required: true,
        schema: {
          type: "integer",
          description: "The maximum number of items to return.",
        },
      },
    ];

    const inputSchema = createInputSchema({ body: bodySchema, parameters });
    expect(inputSchema).toMatchInlineSnapshot(`
      {
        "properties": {
          "as_user": {
            "description": "Pass true to post the message as the authed user, instead of as a bot. Defaults to false. See [authorship](#authorship) below.",
            "type": "string",
          },
          "attachments": {
            "description": "A JSON-based array of structured attachments, presented as a URL-encoded string.",
            "type": "string",
          },
          "channel": {
            "description": "Channel, private group, or IM channel to send message to. Can be an encoded ID, or a name. See [below](#channels) for more details.",
            "type": "string",
          },
          "limit": {
            "description": "The maximum number of items to return.",
            "type": "integer",
          },
        },
        "required": [
          "channel",
          "limit",
        ],
        "type": "object",
      }
    `);
  } catch (e: any) {
    console.error(JSON.stringify(e.errors, null, 2));
    expect(e).toEqual(null);
  }
});
