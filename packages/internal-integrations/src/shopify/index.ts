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

const log = debug("trigger:integrations:slack");
type SearchVariantsSuccessResponse = z.infer<
  typeof shopify.schemas.SearchVariantsSuccessResponseSchema
>;
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
      case "productVariants.search": {
        return this.#searchProductVariants(client, options.params);
      }
      default: {
        throw new Error(`Unknown endpoint: ${options.endpoint}`);
      }
    }
  }

  displayProperties(endpoint: string, params: any): DisplayProperties {
    return {
      title: "Temporary",
    };
    throw new Error(`Unknown endpoint: ${endpoint}`);
  }

  async #searchProductVariants(
    client: Client,
    params: any
  ): Promise<PerformedRequestResponse> {
    const parsedParams = shopify.schemas.SearchVariantsBodySchema.parse(params);
    log("productVariants.search %O", parsedParams);

    try {
      const firstLast = buildFirstLast(parsedParams);
      const filters = parsedParams.filter
        ? buildFilter(parsedParams.filter)
        : undefined;

      const query = gql`
        query {
          productVariants(${firstLast}${filters ? `, ${filters}` : ""}) {
            edges {
              node {
                id
                title
                createdAt
                updatedAt
                price
                product {
                  id
                }
                sku
                barcode
                compareAtPrice
                fulfillmentService {
                  id
                }
                image {
                  id
                }
                inventoryQuantity
                requiresShipping
                position
                taxCode
                taxable
                weight
                weightUnit
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `;
      const result = await client.query(query, {}).toPromise();

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

      console.log("result.data", JSON.stringify(result.data));

      const parsed = VariantsSearchQueryResultSchema.parse(result.data);

      const response: SearchVariantsSuccessResponse = {
        count: parsed.productVariants.edges.length,
        productVariants: parsed.productVariants.edges.map((p) => ({
          id: p.node.id,
          title: p.node.id,
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

      const performedRequest = {
        ok: true,
        isRetryable: false,
        response: {
          output: response,
          context: {},
        },
      };

      log("productVariants.search performedRequest %O", performedRequest);

      return performedRequest;
    } catch (error) {
      console.error("productVariants.search query error %O", error);
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
}

export const requests = new ShopifyRequestIntegration();

function buildFirstLast(
  firstLast: z.infer<typeof shopify.schemas.FirstOrLastSchema>
) {
  let first = firstLast.first;
  if (first === undefined && firstLast.last === undefined) {
    first = 100;
  }

  if (first !== undefined) {
    return `first: ${first}`;
  }
  return `last: ${firstLast.last}`;
}

function buildFilter(filter: Record<string, string[]>): string {
  let filterQueries: string[] = [];

  for (const [key, values] of Object.entries(filter)) {
    filterQueries.push(
      `(${values.map((value) => `${key}:${value}`).join(" OR ")})`
    );
  }

  return filterQueries.join(" AND ");
}

const VariantsSearchQueryResultSchema = z.object({
  productVariants: z.object({
    edges: z.array(z.object({ node: shopify.schemas.ProductVariantSchema })),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
    }),
  }),
});
