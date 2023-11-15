import { Product, ProductDeleted } from "./schemas";

export const onProductProperties = (payload: Product | ProductDeleted) => {
  return [{ label: "Product ID", text: String(payload.id) }];
};
