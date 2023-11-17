import { Base } from "@shopify/shopify-api/rest/base";
import { RecursiveShopifySerializer } from "./types";

export const basicProperties = (payload: { id: string | number }) => {
  return [{ label: "ID", text: String(payload.id) }];
};

export const serializeShopifyResource = <TResource extends Base | Base[] | null>(
  resource: TResource
): RecursiveShopifySerializer<TResource> => {
  return JSON.parse(JSON.stringify(resource));
};
