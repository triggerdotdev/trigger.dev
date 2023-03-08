import { schemaFromRef } from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";
import { spec } from "../schemas/spec";

export const checkoutSessionCompletedSchema: JSONSchema = schemaFromRef(
  "#/components/schemas/checkout.session",
  spec
);
