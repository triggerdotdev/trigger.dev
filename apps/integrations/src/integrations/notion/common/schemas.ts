import { EndpointSpecParameter } from "core/endpoint/types";
import {
  makeOneOf,
  makeObjectSchema,
  makeStringSchema,
  makeNullable,
  makeBooleanSchema,
} from "core/schemas/makeSchema";

export const VersionHeaderParam: EndpointSpecParameter = {
  name: "Notion-Version",
  in: "header",
  description:
    "The Notion API is versioned. Our API versions are named for the date the version is released, for example, 2022-06-28",
  schema: {
    type: "string",
  },
  required: true,
};

export const UserSchema = makeOneOf("User", [
  makeObjectSchema("Person", {
    requiredProperties: {
      object: makeStringSchema("Object type", "This is always user", {
        enum: ["user"],
      }),
      id: makeStringSchema("User ID", "Unique identifier for this user"),
      type: makeStringSchema(
        "User type",
        "The user's type, either person or bot",
        {
          enum: ["person"],
        }
      ),
      person: makeObjectSchema("Person", {
        requiredProperties: {
          email: makeStringSchema("Email", "The user's email address"),
        },
      }),
    },
    optionalProperties: {
      name: makeStringSchema("The user's full name", "The user's full name"),
      avatar_url: makeNullable(
        makeStringSchema("Avatar URL", "The user's avatar URL")
      ),
    },
  }),
  makeObjectSchema("Bot", {
    requiredProperties: {
      object: makeStringSchema("Object type", "This is always user", {
        enum: ["user"],
      }),
      id: makeStringSchema("User ID", "Unique identifier for this user"),
      type: makeStringSchema(
        "User type",
        "The user's type, either person or bot",
        {
          enum: ["bot"],
        }
      ),
      bot: makeObjectSchema("Bot", {
        optionalProperties: {
          owner: makeObjectSchema("Owner", {
            requiredProperties: {
              type: makeStringSchema(
                "Owner type",
                "The owner's type, either user or workspace",
                {
                  enum: ["user", "workspace"],
                }
              ),
            },
            optionalProperties: {
              workspace: makeNullable(
                makeBooleanSchema("Workspace", "Is this a workspace?")
              ),
            },
          }),
          workspace_name: makeNullable(
            makeStringSchema("Workspace name", "The name of the workspace")
          ),
        },
      }),
    },
    optionalProperties: {
      name: makeStringSchema("The user's full name", "The user's full name"),
      avatar_url: makeNullable(
        makeStringSchema("Avatar URL", "The user's avatar URL")
      ),
    },
  }),
]);
