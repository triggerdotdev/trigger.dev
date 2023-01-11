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
    throw new Error("Cannot call getProducts outside of a trigger run");
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
    throw new Error("Cannot call getProducts outside of a trigger run");
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
    throw new Error("Cannot call getProducts outside of a trigger run");
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
    throw new Error("Cannot call getProducts outside of a trigger run");
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
