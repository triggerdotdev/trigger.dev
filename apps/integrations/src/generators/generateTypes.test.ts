import { expect, test } from "vitest";
import { getTypesFromSchema as generateTypesFromSchema } from "./generateTypes";

test("simple schema type generation", async () => {
  try {
    const schema = {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "ID of conversation to join",
        },
      },
      required: ["channel"],
    };

    const data = await generateTypesFromSchema(schema, "Input");
    expect(data).toMatchInlineSnapshot(`
      "export interface Input {
      /**
       * ID of conversation to join
       */
      channel: string
      }
      "
    `);
  } catch (e: any) {
    console.error(JSON.stringify(e.errors, null, 2));
    expect(e).toEqual(null);
  }
});

test("advanced schema type generation", async () => {
  try {
    const schema = {
      type: "object",
      properties: {
        channel: {
          type: "string",
        },
        message: {
          type: "object",
          properties: {
            attachments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  fallback: {
                    type: "string",
                  },
                  id: {
                    type: "number",
                  },
                  text: {
                    type: "string",
                  },
                },
                required: ["fallback", "id", "text"],
              },
            },
            bot_id: {
              type: "string",
            },
            subtype: {
              type: "string",
            },
            text: {
              type: "string",
            },
            ts: {
              type: "string",
            },
            type: {
              type: "string",
            },
            user: {
              type: "string",
            },
          },
          required: ["bot_id", "text", "ts", "type"],
        },
        ok: {
          type: "boolean",
        },
        ts: {
          type: "string",
        },
      },
      required: ["channel", "message", "ok", "ts"],
    };

    const data = await generateTypesFromSchema(schema, "Input");
    expect(data).toMatchInlineSnapshot(`
      "export interface Input {
      channel: string
      message: {
      attachments?: {
      fallback: string
      id: number
      text: string
      }[]
      bot_id: string
      subtype?: string
      text: string
      ts: string
      type: string
      user?: string
      }
      ok: boolean
      ts: string
      }
      "
    `);
  } catch (e: any) {
    console.error(JSON.stringify(e.errors, null, 2));
    expect(e).toEqual(null);
  }
});
