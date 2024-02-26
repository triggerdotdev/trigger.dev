import { Attributes } from "@opentelemetry/api";
import { Accessory } from "../schemas";
import { flattenAttributes } from "./flattenAttributes";
import { SemanticInternalAttributes } from "../semanticInternalAttributes";

export function accessoryAttributes(accessory: Accessory): Attributes {
  return flattenAttributes(accessory, SemanticInternalAttributes.STYLE_ACCESSORY);
}
