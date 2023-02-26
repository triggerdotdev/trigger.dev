import { JSONSchema } from "core/schemas/types";

export const GetUserPathParameters: JSONSchema = {
  "type": "object",
  "properties": {
    "user_id": IdRequest
  },
  "required": [
    "user_id"
  ],
  "additionalProperties": false
};

export const GetUserParameters: JSONSchema = GetUserPathParameters;

export const GetUserResponse: JSONSchema = UserObjectResponse;