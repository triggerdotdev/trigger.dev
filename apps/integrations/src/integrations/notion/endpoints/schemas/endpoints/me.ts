import { JSONSchema } from "core/schemas/types";
import { NeverRecord } from "../common";
import { UserObjectResponse } from "../person";

export const GetSelfParameters: JSONSchema = NeverRecord;
export const GetSelfResponse: JSONSchema = UserObjectResponse;
