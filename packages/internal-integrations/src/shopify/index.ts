import debug from "debug";
import {
  DisplayProperties,
  PerformedRequestResponse,
  PerformRequestOptions,
  RequestIntegration,
} from "../types";
import { Client, createClient, gql } from "@urql/core";
import { shopify } from "@trigger.dev/providers";
import { z } from "zod";
import {
  addProductsToCollectionQuery,
  appendProductImagesQuery,
  createProductQuery,
  createProductVariantsQuery,
  defaultFirst,
  listCollectionsQuery,
  listLocationsQuery,
  searchProductVariantsQuery,
  updateProductQuery,
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
      case "product.update": {
        return this.#updateProduct(client, options.params);
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
      case "collections.list": {
        return this.#listCollections(client, options.params);
      }
      case "locations.list": {
        return this.#listLocations(client, options.params);
      }
      case "collection.addProducts": {
        return this.#addProductsToCollection(client, options.params);
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
      case "product.update": {
        const parsedParams =
          shopify.schemas.UpdateProductBodySchema.parse(params);
        return {
          title: `Update product: ${parsedParams.id}`,
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
      case "collections.list": {
        return {
          title: "List collections",
        };
      }
      case "locations.list": {
        return {
          title: "List locations",
        };
      }
      case "collection.addProducts": {
        const parsedParams =
          shopify.schemas.AddProductsToCollectionBodySchema.parse(params);
        return {
          title: `Add products to collection: ${parsedParams.collectionId}`,
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

  async #updateProduct(
    client: Client,
    params: any
  ): Promise<PerformedRequestResponse> {
    const parsedParams = shopify.schemas.UpdateProductBodySchema.parse(params);
    log("product.update %O", parsedParams);

    try {
      const result = await client
        .mutation(updateProductQuery, {
          input: parsedParams,
        })
        .toPromise();

      if (result.error) {
        log("product.update failed %O", result.error);
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
        log("product.update data undefined %O");
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
        result.data.productUpdate.userErrors &&
        result.data.productUpdate.userErrors.length > 0
      ) {
        log("product.update userErrors %O", result.data.userErrors);
        return {
          ok: false,
          isRetryable: false,
          response: {
            output: result.data.productUpdate.userErrors,
            context: {},
          },
        };
      }

      const product = {
        ...result.data.productUpdate.product,
        images: result.data.productUpdate.product.images?.edges?.map(
          (e: any) => e.node
        ),
        variants: result.data.productUpdate.product.variants?.edges?.map(
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

      log("product.update performedRequest %O", performedRequest);

      return performedRequest;
    } catch (error) {
      log("product.update query error %O", error);
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

  async #listCollections(
    client: Client,
    params: any
  ): Promise<PerformedRequestResponse> {
    const parsedParams =
      shopify.schemas.ListCollectionsBodySchema.parse(params);
    log("collections.list %O", parsedParams);

    try {
      const filters = parsedParams.filter
        ? buildFilter(parsedParams.filter)
        : undefined;

      const result = await client
        .query(listCollectionsQuery, {
          first: parsedParams.first ?? defaultFirst,
          filters: filters,
        })
        .toPromise();

      if (result.error) {
        log("collections.list failed %O", result.error);
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
        log("collections.list data undefined %O");
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

      const response = result.data.collections.edges.map((c: any) => ({
        id: c.node.id,
        title: c.node.title,
        handle: c.node.handle,
        updatedAt: c.node.updatedAt,
        productsCount: c.node.productsCount,
        sortOrder: c.node.sortOrder,
      }));

      const validatedResponse =
        shopify.schemas.ListCollectionsResponseSchema.parse(response);

      const performedRequest = {
        ok: true,
        isRetryable: false,
        response: {
          output: validatedResponse,
          context: {},
        },
      };

      log("collections.list performedRequest %O", performedRequest);

      return performedRequest;
    } catch (error) {
      log("collections.list query error %O", error);
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

  async #listLocations(
    client: Client,
    params: any
  ): Promise<PerformedRequestResponse> {
    const parsedParams = shopify.schemas.ListLocationsBodySchema.parse(params);
    log("locations.list %O", parsedParams);

    try {
      const result = await client
        .query(listLocationsQuery, {
          first: parsedParams.first ?? defaultFirst,
        })
        .toPromise();

      if (result.error) {
        log("locations.list failed %O", result.error);
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
        log("locations.list data undefined %O");
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

      const response = result.data.locations.edges.map((c: any) => ({
        id: c.node.id,
        name: c.node.name,
        isActive: c.node.isActive,
      }));

      const validatedResponse =
        shopify.schemas.ListLocationsResponseSchema.parse(response);

      const performedRequest = {
        ok: true,
        isRetryable: false,
        response: {
          output: validatedResponse,
          context: {},
        },
      };

      log("locations.list performedRequest %O", performedRequest);

      return performedRequest;
    } catch (error) {
      log("locations.list query error %O", error);
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

  async #addProductsToCollection(
    client: Client,
    params: any
  ): Promise<PerformedRequestResponse> {
    const parsedParams =
      shopify.schemas.AddProductsToCollectionBodySchema.parse(params);
    log("collection.addProducts %O", parsedParams);

    try {
      const result = await client
        .mutation(addProductsToCollectionQuery, {
          id: parsedParams.collectionId,
          productIds: parsedParams.productIds,
        })
        .toPromise();

      if (result.error) {
        log("collection.addProducts failed %O", result.error);
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
        log("collection.addProducts data undefined %O");
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

      const userErrors = result.data.collectionAddProducts.userErrors;
      if (userErrors && userErrors.length > 0) {
        log(
          "collection.addProducts userErrors %O",
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

      const data = { collection: result.data.collectionAddProducts.collection };

      const validatedProduct =
        shopify.schemas.AddProductsToCollectionResponseSchema.parse(data);

      const performedRequest = {
        ok: true,
        isRetryable: false,
        response: {
          output: validatedProduct,
          context: {},
        },
      };

      log("collection.addProducts performedRequest %O", performedRequest);

      return performedRequest;
    } catch (error) {
      log("collection.addProducts query error %O", error);
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
