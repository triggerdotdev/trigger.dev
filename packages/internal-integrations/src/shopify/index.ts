import debug from "debug";
import {
  DisplayProperties,
  PerformedRequestResponse,
  PerformRequestOptions,
  RequestIntegration,
} from "../types";
import { Client, createClient, gql } from "@urql/core";
import { shopify } from "internal-providers";
import { z } from "zod";
import {
  appendProductImagesQuery,
  createProductQuery,
  createProductVariantsQuery,
  defaultFirst,
  searchProductVariantsQuery,
} from "./queries";

const log = debug("trigger:integrations:shopify");
class ShopifyRequestIntegration implements RequestIntegration {
  constructor(
    private readonly baseUrlFormat: string = "https://{shop}.myshopify.com/admin/api/2021-07/graphql.json"
  ) {}

  async perform(
    options: PerformRequestOptions
  ): Promise<PerformedRequestResponse> {
    if (options.accessInfo.type === "oauth2") {
      throw new Error("OAuth isn't currently supported for Shopify");
    }

    if (options.accessInfo.additionalFields?.store_name === undefined) {
      throw new Error("Missing store_name");
    }

    const url = this.baseUrlFormat.replace(
      "{shop}",
      options.accessInfo.additionalFields.store_name
    );
    const client = createClient({
      url,
      fetchOptions: {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": options.accessInfo.api_key,
        },
      },
    });

    switch (options.endpoint) {
      case "product.create": {
        return this.#createProduct(client, options.params);
      }
      case "productVariants.search": {
        return this.#searchProductVariants(client, options.params);
      }
      case "productVariant.create": {
        return this.#createProductVariant(client, options.params);
      }
      case "productImages.append": {
        return this.#appendProductImages(client, options.params);
      }
      default: {
        throw new Error(`Unknown endpoint: ${options.endpoint}`);
      }
    }
  }

  displayProperties(endpoint: string, params: any): DisplayProperties {
    switch (endpoint) {
      case "product.create": {
        const parsedParams =
          shopify.schemas.CreateProductBodySchema.parse(params);
        return {
          title: `Create product: ${parsedParams.title}`,
        };
      }
      case "productVariants.search": {
        const parsedParams =
          shopify.schemas.SearchVariantsBodySchema.parse(params);
        return {
          title: "Search product variants",
          properties: [
            {
              key: "first",
              value: parsedParams.first ?? defaultFirst,
            },
            ...Object.entries(parsedParams.filter ?? {}).map(
              ([key, value]) => ({
                key,
                value: value.join(", "),
              })
            ),
          ],
        };
      }
      case "productVariant.create": {
        const parsedParams =
          shopify.schemas.CreateVariantBodySchema.parse(params);
        return {
          title: `Create product variant for ${parsedParams.productId}`,
        };
      }
      case "productImages.append": {
        const parsedParams =
          shopify.schemas.AppendProductImagesBodySchema.parse(params);
        return {
          title: `Append product images to: ${parsedParams.id}`,
        };
      }
      default: {
        return {
          title: "Unknown endpoint",
        };
      }
    }
  }

  async #searchProductVariants(
    client: Client,
    params: any
  ): Promise<PerformedRequestResponse> {
    const parsedParams = shopify.schemas.SearchVariantsBodySchema.parse(params);
    log("productVariants.search %O", parsedParams);

    try {
      const filters = parsedParams.filter
        ? buildFilter(parsedParams.filter)
        : undefined;

      const result = await client
        .query(searchProductVariantsQuery, {
          first: parsedParams.first ?? defaultFirst,
          filters: filters,
        })
        .toPromise();

      if (result.error) {
        log("productVariants.search failed %O", result.error);
        return {
          ok: false,
          isRetryable: false,
          response: {
            output: result.error,
            context: {},
          },
        };
      }

      if (result.data === undefined) {
        log("productVariants.search data undefined %O");
        return {
          ok: false,
          isRetryable: false,
          response: {
            output: {
              message: "No data returned",
            },
            context: {},
          },
        };
      }

      const response = {
        count: result.data.productVariants.edges.length,
        productVariants: result.data.productVariants.edges.map((p: any) => ({
          id: p.node.id,
          title: p.node.title,
          createdAt: p.node.createdAt,
          updatedAt: p.node.updatedAt,
          price: p.node.price,
          product: p.node.product,
          sku: p.node.sku,
          barcode: p.node.barcode,
          compareAtPrice: p.node.compareAtPrice,
          fulfillmentService: p.node.fulfillmentService,
          image: p.node.image,
          inventoryQuantity: p.node.inventoryQuantity,
          requiresShipping: p.node.requiresShipping,
          position: p.node.position,
          taxCode: p.node.taxCode,
          taxable: p.node.taxable,
          weight: p.node.weight,
          weightUnit: p.node.weightUnit,
        })),
      };

      const validatedResponse =
        shopify.schemas.SearchVariantsSuccessResponseSchema.parse(response);

      const performedRequest = {
        ok: true,
        isRetryable: false,
        response: {
          output: validatedResponse,
          context: {},
        },
      };

      log("productVariants.search performedRequest %O", performedRequest);

      return performedRequest;
    } catch (error) {
      log("productVariants.search query error %O", error);
      return {
        ok: false,
        isRetryable: false,
        response: {
          output: error,
          context: {},
        },
      };
    }
  }

  async #createProductVariant(
    client: Client,
    params: any
  ): Promise<PerformedRequestResponse> {
    const parsedParams = shopify.schemas.CreateVariantBodySchema.parse(params);
    log("productVariant.create %O", parsedParams);

    try {
      const result = await client
        .mutation(createProductVariantsQuery, {
          input: parsedParams,
        })
        .toPromise();

      if (result.error) {
        log("productVariant.create failed %O", result.error);
        return {
          ok: false,
          isRetryable: false,
          response: {
            output: result.error,
            context: {},
          },
        };
      }

      if (result.data === undefined) {
        log("productVariant.create data undefined %O");
        return {
          ok: false,
          isRetryable: false,
          response: {
            output: {
              message: "No data returned",
            },
            context: {},
          },
        };
      }

      if (
        result.data.productVariantCreate.userErrors &&
        result.data.productVariantCreate.userErrors.length > 0
      ) {
        log("productVariant.create userErrors %O", result.data.userErrors);
        return {
          ok: false,
          isRetryable: false,
          response: {
            output: result.data.productVariantCreate.userErrors,
            context: {},
          },
        };
      }

      const productVariant = result.data.productVariantCreate.productVariant;

      const validatedProductVariant =
        shopify.schemas.ProductVariantSchema.parse(productVariant);

      const performedRequest = {
        ok: true,
        isRetryable: false,
        response: {
          output: validatedProductVariant,
          context: {},
        },
      };

      log("productVariant.create performedRequest %O", performedRequest);

      return performedRequest;
    } catch (error) {
      log("productVariant.create query error %O", error);
      return {
        ok: false,
        isRetryable: false,
        response: {
          output: error,
          context: {},
        },
      };
    }
  }

  async #createProduct(
    client: Client,
    params: any
  ): Promise<PerformedRequestResponse> {
    const parsedParams = shopify.schemas.CreateProductBodySchema.parse(params);
    log("product.create %O", parsedParams);

    try {
      const result = await client
        .mutation(createProductQuery, {
          input: parsedParams,
        })
        .toPromise();

      if (result.error) {
        log("product.create failed %O", result.error);
        return {
          ok: false,
          isRetryable: false,
          response: {
            output: result.error,
            context: {},
          },
        };
      }

      if (result.data === undefined) {
        log("product.create data undefined %O");
        return {
          ok: false,
          isRetryable: false,
          response: {
            output: {
              message: "No data returned",
            },
            context: {},
          },
        };
      }

      if (
        result.data.productCreate.userErrors &&
        result.data.productCreate.userErrors.length > 0
      ) {
        log("product.create userErrors %O", result.data.userErrors);
        return {
          ok: false,
          isRetryable: false,
          response: {
            output: result.data.productCreate.userErrors,
            context: {},
          },
        };
      }

      const product = {
        ...result.data.productCreate.product,
        images: result.data.productCreate.product.images?.edges?.map(
          (e: any) => e.node
        ),
        variants: result.data.productCreate.product.variants?.edges?.map(
          (e: any) => e.node
        ),
      };

      const validatedProduct = shopify.schemas.ProductSchema.parse(product);

      const performedRequest = {
        ok: true,
        isRetryable: false,
        response: {
          output: validatedProduct,
          context: {},
        },
      };

      log("product.create performedRequest %O", performedRequest);

      return performedRequest;
    } catch (error) {
      log("product.create query error %O", error);
      return {
        ok: false,
        isRetryable: false,
        response: {
          output: error,
          context: {},
        },
      };
    }
  }

  async #appendProductImages(
    client: Client,
    params: any
  ): Promise<PerformedRequestResponse> {
    const parsedParams =
      shopify.schemas.AppendProductImagesBodySchema.parse(params);
    log("productImages.append %O", parsedParams);

    try {
      const result = await client
        .mutation(appendProductImagesQuery, {
          input: parsedParams,
        })
        .toPromise();

      if (result.error) {
        log("productImages.append failed %O", result.error);
        return {
          ok: false,
          isRetryable: false,
          response: {
            output: result.error,
            context: {},
          },
        };
      }

      if (result.data === undefined) {
        log("productImages.append data undefined %O");
        return {
          ok: false,
          isRetryable: false,
          response: {
            output: {
              message: "No data returned",
            },
            context: {},
          },
        };
      }

      const userErrors = result.data.productAppendImages.userErrors;
      if (userErrors && userErrors.length > 0) {
        log(
          "productImages.append userErrors %O",
          result.data.productAppendImages
        );
        return {
          ok: false,
          isRetryable: false,
          response: {
            output: userErrors,
            context: {},
          },
        };
      }

      const newImages = result.data.productAppendImages.newImages;

      const validatedProduct =
        shopify.schemas.AppendProductImagesResponseSchema.parse(newImages);

      const performedRequest = {
        ok: true,
        isRetryable: false,
        response: {
          output: validatedProduct,
          context: {},
        },
      };

      log("productImages.append performedRequest %O", performedRequest);

      return performedRequest;
    } catch (error) {
      log("productImages.append query error %O", error);
      return {
        ok: false,
        isRetryable: false,
        response: {
          output: error,
          context: {},
        },
      };
    }
  }
}

export const requests = new ShopifyRequestIntegration();

function buildFilter(filter: Record<string, string[]>): string {
  let filterQueries: string[] = [];

  for (const [key, values] of Object.entries(filter)) {
    filterQueries.push(
      `(${values
        .map((value) => `${titleCaseToSnakeCase(key)}:${value}`)
        .join(" OR ")})`
    );
  }

  return filterQueries.join(" AND ");
}

function titleCaseToSnakeCase(input: string): string {
  return input.replace(/([A-Z])/g, (g) => `_${g[0].toLowerCase()}`);
}
