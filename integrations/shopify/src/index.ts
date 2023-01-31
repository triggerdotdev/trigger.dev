import { getTriggerRun } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  SearchVariantsBodySchema,
  SearchVariantsSuccessResponseSchema,
  CreateVariantBodySchema,
  ProductVariantSchema,
  GetProductBodySchema,
  ProductSchema,
  CreateProductBodySchema,
  UpdateProductBodySchema,
  AppendProductImagesBodySchema,
  AppendProductImagesResponseSchema,
  ListCollectionsBodySchema,
  ListCollectionsResponseSchema,
  ListLocationsBodySchema,
  ListLocationsResponseSchema,
  AddProductsToCollectionBodySchema,
  AddProductsToCollectionResponseSchema,
} from "./schemas";

export type SearchVariantsOptions = z.infer<typeof SearchVariantsBodySchema>;
export type SearchVariantsResponse = z.infer<
  typeof SearchVariantsSuccessResponseSchema
>;

export async function searchProductVariants(
  key: string,
  options: SearchVariantsOptions
): Promise<SearchVariantsResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error(
      "Cannot call searchProductVariants outside of a trigger run"
    );
  }

  const output = await run.performRequest(key, {
    service: "shopify",
    endpoint: "productVariants.search",
    params: options,
    response: {
      schema: SearchVariantsSuccessResponseSchema,
    },
  });

  return output;
}

export type CreateVariantBody = z.infer<typeof CreateVariantBodySchema>;

export type CreateVariantResponse = z.infer<typeof ProductVariantSchema>;

export async function createProductVariant(
  key: string,
  options: CreateVariantBody
): Promise<CreateVariantResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error(
      "Cannot call createProductVariant outside of a trigger run"
    );
  }

  const output = await run.performRequest(key, {
    service: "shopify",
    endpoint: "productVariant.create",
    params: options,
    response: {
      schema: ProductVariantSchema,
    },
  });

  return output;
}

export type GetProductBody = z.infer<typeof GetProductBodySchema>;

export type GetProductResponse = z.infer<typeof ProductSchema>;

export async function getProduct(
  key: string,
  options: GetProductBody
): Promise<GetProductResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call getProduct outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "shopify",
    endpoint: "product.get",
    params: options,
    response: {
      schema: ProductSchema,
    },
  });

  return output;
}

export type CreateProductBody = z.infer<typeof CreateProductBodySchema>;

export type CreateProductResponse = z.infer<typeof ProductSchema>;

export async function createProduct(
  key: string,
  options: CreateProductBody
): Promise<CreateProductResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call createProduct outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "shopify",
    endpoint: "product.create",
    params: options,
    response: {
      schema: ProductSchema,
    },
  });

  return output;
}

export type UpdateProductBody = z.infer<typeof UpdateProductBodySchema>;

export type UpdateProductResponse = z.infer<typeof ProductSchema>;

export async function updateProduct(
  key: string,
  options: UpdateProductBody
): Promise<UpdateProductResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call updateProduct outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "shopify",
    endpoint: "product.update",
    params: options,
    response: {
      schema: ProductSchema,
    },
  });

  return output;
}

export type AppendProductImagesBody = z.infer<
  typeof AppendProductImagesBodySchema
>;

export type AppendProductImagesResponse = z.infer<
  typeof AppendProductImagesResponseSchema
>;

export async function appendProductImages(
  key: string,
  options: AppendProductImagesBody
): Promise<AppendProductImagesResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call appendProductImages outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "shopify",
    endpoint: "productImages.append",
    params: options,
    response: {
      schema: AppendProductImagesResponseSchema,
    },
  });

  return output;
}

export type ListCollectionsBody = z.infer<typeof ListCollectionsBodySchema>;

export type ListCollectionsResponse = z.infer<
  typeof ListCollectionsResponseSchema
>;

export async function listCollections(
  key: string,
  options: ListCollectionsBody
): Promise<ListCollectionsResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call listCollections outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "shopify",
    endpoint: "collections.list",
    params: options,
    response: {
      schema: ListCollectionsResponseSchema,
    },
  });

  return output;
}

export type ListLocationsBody = z.infer<typeof ListLocationsBodySchema>;

export type ListLocationsResponse = z.infer<typeof ListLocationsResponseSchema>;

export async function listLocations(
  key: string,
  options: ListLocationsBody
): Promise<ListLocationsResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call listLocations outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "shopify",
    endpoint: "locations.list",
    params: options,
    response: {
      schema: ListLocationsResponseSchema,
    },
  });

  return output;
}

export type AddProductsToCollectionBody = z.infer<
  typeof AddProductsToCollectionBodySchema
>;

export type AddProductsToCollectionResponse = z.infer<
  typeof AddProductsToCollectionResponseSchema
>;

export async function addProductsToCollection(
  key: string,
  options: AddProductsToCollectionBody
): Promise<AddProductsToCollectionResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error(
      "Cannot call addProductsToCollection outside of a trigger run"
    );
  }

  const output = await run.performRequest(key, {
    service: "shopify",
    endpoint: "collection.addProducts",
    params: options,
    response: {
      schema: AddProductsToCollectionResponseSchema,
    },
  });

  return output;
}
