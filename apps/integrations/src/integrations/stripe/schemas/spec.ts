import { transformNullables } from "core/schemas/transformNullables";
import { JSONSchema } from "core/schemas/types";
import rawSpec from "./spec3.json";
transformNullables(rawSpec);
export const spec: JSONSchema = rawSpec;
