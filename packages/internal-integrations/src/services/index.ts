import { z } from "zod";
import { normalizeHeaders } from "../headers";
import debug from "debug";

const log = debug("trigger:integrations:services");

export type HttpServiceOptions = {
  accessToken: string;
  baseUrl: string;
};

export type HttpResponse<
  TResponseSchema extends z.ZodTypeAny,
  TErrorResponseSchema extends z.ZodTypeAny = z.AnyZodObject
> =
  | {
      success: true;
      statusCode: number;
      headers: Record<string, string>;
      data: z.infer<TResponseSchema>;
    }
  | {
      success: false;
      statusCode: number;
      headers: Record<string, string>;
      error?: z.infer<TErrorResponseSchema>;
    };

export class HttpService {
  constructor(private readonly options: HttpServiceOptions) {}

  async performRequest<
    TResponseSchema extends z.ZodTypeAny,
    TBodySchema extends z.ZodTypeAny = z.ZodUndefined
  >(
    endpoint: HttpEndpoint<TResponseSchema, TBodySchema>,
    body?: z.infer<TBodySchema>
  ): Promise<HttpResponse<TResponseSchema>> {
    const url = `${this.options.baseUrl}${endpoint.options.path}`;
    const method = endpoint.options.method;
    const headers = {
      Authorization: `Bearer ${this.options.accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    };
    const actualBody = body ? JSON.stringify(body) : undefined;

    const response = await fetch(url, {
      method,
      headers,
      body: actualBody,
    });

    log(
      "%s%s response %d",
      this.options.baseUrl,
      endpoint.options.path,
      response.status
    );

    const json = await this.#safeGetJson(response);

    if (json) {
      log(
        "%s%s response %O",
        this.options.baseUrl,
        endpoint.options.path,
        json
      );

      const parsedJson = endpoint.options.response.safeParse(json);

      if (parsedJson.success) {
        return {
          success: true,
          data: parsedJson.data,
          statusCode: response.status,
          headers: normalizeHeaders(response.headers),
        };
      }

      log(
        "response json failed to parse %O, errors: %O",
        parsedJson,
        parsedJson.error
      );

      return {
        success: false,
        statusCode: response.status,
        headers: normalizeHeaders(response.headers),
        error: { type: "zod-parse", issues: parsedJson.error.issues },
      };
    }

    return {
      success: false,
      statusCode: response.status,
      headers: normalizeHeaders(response.headers),
    };
  }

  #safeGetJson = async (response: Response) => {
    try {
      return await response.json();
    } catch (error) {
      return undefined;
    }
  };
}

export type HttpEndpointOptions<
  TResponseSchema extends z.ZodTypeAny,
  TBodySchema extends z.ZodTypeAny = z.ZodUndefined
> = {
  response: TResponseSchema;
  body?: TBodySchema;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
};

export class HttpEndpoint<
  TResponseSchema extends z.ZodTypeAny,
  TBodySchema extends z.ZodTypeAny = z.ZodUndefined
> {
  constructor(
    public options: HttpEndpointOptions<TResponseSchema, TBodySchema>
  ) {}
}
