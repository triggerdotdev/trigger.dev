type OpenAIHTTPMethod = "get" | "post" | "put" | "patch" | "delete";
type OpenAIHeaders = Record<string, string | null | undefined>;
type OpenAIQuery = Record<string, string | undefined>;

export type OpenAIIntegrationOptions = {
  id: string;
  apiKey?: string;
  organization?: string;
  baseURL?: string;
  icon?: string;

  /**
   * Default headers to include with every request to the API.
   *
   * These can be removed in individual requests by explicitly setting the
   * header to `undefined` or `null` in request options.
   */
  defaultHeaders?: OpenAIHeaders;

  /**
   * Default query parameters to include with every request to the API.
   *
   * These can be removed in individual requests by explicitly setting the
   * param to `undefined` in request options.
   */
  defaultQuery?: OpenAIQuery;
};

export type OpenAIIntegrationAuth = Omit<OpenAIIntegrationOptions, "id">;

export type OpenAIRequestOptions = {
  method?: OpenAIHTTPMethod;
  query?: OpenAIQuery;
  path?: string;
  headers?: OpenAIHeaders;
  idempotencyKey?: string;
};