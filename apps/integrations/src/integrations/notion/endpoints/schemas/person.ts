import {
  makeOneOf,
  makeObjectSchema,
  makeStringSchema,
  makeBooleanSchema,
  makeNullable,
} from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";

const UserObjectTypeSchema = makeStringSchema(
  "Object type",
  "This is always user",
  {
    const: "user",
  }
);

const UserIdSchema = makeStringSchema(
  "User ID",
  "Unique identifier for this user"
);

//   export type PersonUserObjectResponse = {
//     type: "person"
//     person: { email?: string }
//     name: string | null
//     avatar_url: string | null
//     id: IdRequest
//     object: "user"
//   }
//most of the time email is required, but sometimes it's optional
export function PersonSchema(optionalEmail = false): JSONSchema {
  return makeObjectSchema("Person", {
    requiredProperties: {
      object: UserObjectTypeSchema,
      id: UserIdSchema,
      type: makeStringSchema(
        "User type",
        "The user's type, either person or bot",
        {
          const: "person",
        }
      ),
      person: makeObjectSchema(
        "Person",
        optionalEmail
          ? {
              optionalProperties: {
                email: makeStringSchema("Email", "The user's email address"),
              },
            }
          : {
              requiredProperties: {
                email: makeStringSchema("Email", "The user's email address"),
              },
            }
      ),
    },
    optionalProperties: {
      name: makeNullable(
        makeStringSchema("The user's full name", "The user's full name")
      ),
      avatar_url: makeNullable(
        makeStringSchema("Avatar URL", "The user's avatar URL")
      ),
    },
  });
}

const BotOwnerSchema = makeOneOf("Bot owner", [
  makeObjectSchema("User owner", {
    requiredProperties: {
      type: makeStringSchema(
        "Owner type",
        "The owner's type, either user or workspace",
        {
          const: "user",
        }
      ),
      user: PersonSchema(),
    },
  }),
  makeObjectSchema("Workspace owner", {
    requiredProperties: {
      type: makeStringSchema(
        "Owner type",
        "The owner's type, either user or workspace",
        {
          const: "workspace",
        }
      ),
      workspace: makeBooleanSchema("Workspace", "Is this a workspace?", {
        const: true,
      }),
    },
  }),
]);

//   export type BotUserObjectResponse = {
//     type: "bot"
//     bot:
//       | EmptyObject
//       | {
//           owner:
//             | {
//                 type: "user"
//                 user:
//                   | {
//                       type: "person"
//                       person: { email: string }
//                       name: string | null
//                       avatar_url: string | null
//                       id: IdRequest
//                       object: "user"
//                     }
//                   | PartialUserObjectResponse
//               }
//             | { type: "workspace"; workspace: true }
//           workspace_name: string | null
//         }
//     name: string | null
//     avatar_url: string | null
//     id: IdRequest
//     object: "user"
//   }
export const BotSchema = makeObjectSchema("Bot", {
  requiredProperties: {
    object: UserObjectTypeSchema,
    id: UserIdSchema,
    type: makeStringSchema(
      "User type",
      "The user's type, either person or bot",
      {
        const: "bot",
      }
    ),
    bot: makeObjectSchema("Bot", {
      optionalProperties: {
        owner: BotOwnerSchema,
        workspace_name: makeNullable(
          makeStringSchema("Workspace name", "The name of the workspace")
        ),
      },
    }),
  },
  optionalProperties: {
    name: makeNullable(
      makeStringSchema("The user's full name", "The user's full name")
    ),
    avatar_url: makeNullable(
      makeStringSchema("Avatar URL", "The user's avatar URL")
    ),
  },
});

export const YourBotSchema = makeObjectSchema("Bot", {
  requiredProperties: {
    object: UserObjectTypeSchema,
    id: UserIdSchema,
    type: makeStringSchema("User type", "Always bot", {
      enum: ["bot"],
    }),
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
            user: makeOneOf("User", [PersonSchema(), BotSchema]),
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
});

// export type PartialUserObjectResponse = { id: IdRequest; object: "user" }
export const PartialUserObjectResponse = makeObjectSchema("PartialUser", {
  requiredProperties: {
    id: makeStringSchema("User ID", "Unique identifier for this user"),
    object: makeStringSchema("Object type", "This is always user", {
      const: "user",
    }),
  },
});

// export type UserObjectResponse =
//   | PersonUserObjectResponse
//   | BotUserObjectResponse;
export const PersonUserObjectResponse = PersonSchema(true);
export const BotUserObjectResponse = BotSchema;
export const UserObjectResponse = makeOneOf("User", [
  PersonUserObjectResponse,
  BotUserObjectResponse,
]);
