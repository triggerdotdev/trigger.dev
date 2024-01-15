import { z } from "zod";
import {
  CreateAuthorizationCodeResponseSchema,
  GetPersonalAccessTokenResponseSchema,
  WhoAmIResponseSchema,
} from "@trigger.dev/core";

export class ApiClient {
  constructor(private readonly apiURL: string) {
    this.apiURL = apiURL;
  }

  async createAuthorizationCode() {
    return zodfetch(
      CreateAuthorizationCodeResponseSchema,
      `${this.apiURL}/api/v1/authorization-code`,
      {
        method: "POST",
      }
    );
  }

  async getPersonalAccessToken(authorizationCode: string) {
    return zodfetch(GetPersonalAccessTokenResponseSchema, `${this.apiURL}/api/v1/token`, {
      method: "POST",
      body: JSON.stringify({
        authorizationCode,
      }),
    });
  }

  async whoAmI({ accessToken }: { accessToken: string }) {
    return zodfetch(WhoAmIResponseSchema, `${this.apiURL}/api/v2/whoami`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }
}

type ApiResult<TSuccessResult> =
  | { success: true; data: TSuccessResult }
  | {
      success: false;
      error: string;
    };

async function zodfetch<TResponseBody extends any>(
  schema: z.Schema<TResponseBody>,
  url: string,
  requestInit?: RequestInit
): Promise<ApiResult<TResponseBody>> {
  try {
    const response = await fetch(url, requestInit);

    if ((!requestInit || requestInit.method === "GET") && response.status === 404) {
      return {
        success: false,
        error: `404: ${response.statusText}`,
      };
    }

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();
      if (!body.error) {
        return { success: false, error: "Something went wrong" };
      }

      return { success: false, error: body.error };
    }

    if (response.status !== 200) {
      return {
        success: false,
        error: `Failed to fetch ${url}, got status code ${response.status}`,
      };
    }

    const jsonBody = await response.json();
    const parsedResult = schema.safeParse(jsonBody);

    if (parsedResult.success) {
      return { success: true, data: parsedResult.data };
    }

    if ("error" in jsonBody) {
      return {
        success: false,
        error: typeof jsonBody.error === "string" ? jsonBody.error : JSON.stringify(jsonBody.error),
      };
    }

    return { success: false, error: parsedResult.error.message };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : JSON.stringify(error),
    };
  }
}
