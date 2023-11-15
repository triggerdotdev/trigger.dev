import { EventSpecificationExample } from "@trigger.dev/sdk";

import ProductCreated from "./ProductCreated.json"
import ProductDeleted from "./ProductDeleted.json"
import ProductUpdated from "./ProductUpdated.json"

export const productCreated: EventSpecificationExample = {
  id: "ProductCreated",
  name: "Product created",
  payload: ProductCreated,
};
export const productDeleted: EventSpecificationExample = {
  id: "ProductDeleted",
  name: "Product deleted",
  payload: ProductDeleted,
};
export const productUpdated: EventSpecificationExample = {
  id: "ProductUpdated",
  name: "Product updated",
  payload: ProductUpdated,
};
