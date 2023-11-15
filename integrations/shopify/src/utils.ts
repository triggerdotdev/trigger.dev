import { Product, DeletedPayload } from "./schemas";

export const onProductProperties = (payload: Product | DeletedPayload) => {
  return [{ label: "Product ID", text: String(payload.id) }];
};
