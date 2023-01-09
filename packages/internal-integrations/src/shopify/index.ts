import debug from "debug";
import {
  DisplayProperties,
  PerformedRequestResponse,
  PerformRequestOptions,
  RequestIntegration,
} from "../types";
import { createClient } from "@urql/core";

const log = debug("trigger:integrations:slack");

class ShopifyRequestIntegration implements RequestIntegration {
  constructor(
    private readonly baseUrlFormat: string = "https://{shop}.myshopify.com/admin/api/2021-07"
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

    const result = await client
      .query(
        `{
    products(first: 5) {
      edges {
        node {
          id
          handle
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }`,
        {}
      )
      .toPromise();

    if (result.error) {
      return {
        ok: false,
        isRetryable: false,
        response: {
          output: result.error,
          context: null,
        },
      };
    }

    return {
      ok: true,
      isRetryable: false,
      response: {
        output: result.data,
        context: null,
      },
    };
  }

  displayProperties(endpoint: string, params: any): DisplayProperties {
    return {
      title: "Temporary",
    };
    throw new Error(`Unknown endpoint: ${endpoint}`);
  }
}

export const requests = new ShopifyRequestIntegration();
