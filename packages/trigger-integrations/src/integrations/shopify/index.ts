import { getTriggerRun } from "@trigger.dev/sdk";
import { z } from "zod";
import { shopify } from "internal-providers";

export type SearchVariantsOptions = z.infer<
  typeof shopify.schemas.SearchVariantsBodySchema
>;
export type SearchVariantsResponse = z.infer<
  typeof shopify.schemas.SearchVariantsSuccessResponseSchema
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
      schema: shopify.schemas.SearchVariantsSuccessResponseSchema,
    },
  });

  return output;
}

export type CreateVariantBody = z.infer<
  typeof shopify.schemas.CreateVariantBodySchema
>;

export type CreateVariantResponse = z.infer<
  typeof shopify.schemas.ProductVariantSchema
>;

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
      schema: shopify.schemas.ProductVariantSchema,
    },
  });

  return output;
}

export type CreateProductBody = z.infer<
  typeof shopify.schemas.CreateProductBodySchema
>;

export type CreateProductResponse = z.infer<
  typeof shopify.schemas.ProductSchema
>;

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
      schema: shopify.schemas.ProductSchema,
    },
  });

  return output;
}

export type UpdateProductBody = z.infer<
  typeof shopify.schemas.UpdateProductBodySchema
>;

export type UpdateProductResponse = z.infer<
  typeof shopify.schemas.ProductSchema
>;

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
      schema: shopify.schemas.ProductSchema,
    },
  });

  return output;
}

export type AppendProductImagesBody = z.infer<
  typeof shopify.schemas.AppendProductImagesBodySchema
>;

export type AppendProductImagesResponse = z.infer<
  typeof shopify.schemas.AppendProductImagesResponseSchema
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
      schema: shopify.schemas.AppendProductImagesResponseSchema,
    },
  });

  return output;
}

export type ListCollectionsBody = z.infer<
  typeof shopify.schemas.ListCollectionsBodySchema
>;

export type ListCollectionsResponse = z.infer<
  typeof shopify.schemas.ListCollectionsResponseSchema
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
      schema: shopify.schemas.ListCollectionsResponseSchema,
    },
  });

  return output;
}

export type ListLocationsBody = z.infer<
  typeof shopify.schemas.ListLocationsBodySchema
>;

export type ListLocationsResponse = z.infer<
  typeof shopify.schemas.ListLocationsResponseSchema
>;

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
      schema: shopify.schemas.ListLocationsResponseSchema,
    },
  });

  return output;
}

export type AddProductsToCollectionBody = z.infer<
  typeof shopify.schemas.AddProductsToCollectionBodySchema
>;

export type AddProductsToCollectionResponse = z.infer<
  typeof shopify.schemas.AddProductsToCollectionResponseSchema
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
      schema: shopify.schemas.AddProductsToCollectionResponseSchema,
    },
  });

  return output;
}
