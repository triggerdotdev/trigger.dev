import { JSONSchema } from "core/schemas/types";
import { IdRequest } from "../common";
import { UserObjectResponse } from "../person";

export const GetUserPathParameters: JSONSchema = {
  type: "object",
  properties: {
    user_id: IdRequest,
  },
  required: ["user_id"],
  additionalProperties: false,
};

export const GetUserParameters: JSONSchema = GetUserPathParameters;

export const GetUserResponse: JSONSchema = UserObjectResponse;
