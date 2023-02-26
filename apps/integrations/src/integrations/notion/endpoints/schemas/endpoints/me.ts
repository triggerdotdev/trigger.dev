import { JSONSchema } from "core/schemas/types";
import { NeverRecord } from "../common";
import { BotUserObjectResponse, PersonUserObjectResponse } from "../person";

export const GetSelfParameters: JSONSchema = NeverRecord;
export const GetSelfResponse: JSONSchema = {
  anyOf: [PersonUserObjectResponse, BotUserObjectResponse],
};
