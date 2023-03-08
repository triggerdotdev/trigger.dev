import { makeRefInSchema } from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";
import { spec } from "../schemas/spec";

export const checkoutSessionCompletedSchema: JSONSchema = makeRefInSchema(
  "#/components/schemas/checkout.session",
  spec
);
