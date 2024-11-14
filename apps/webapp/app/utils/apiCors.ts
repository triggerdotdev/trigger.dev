import { cors } from "remix-utils/cors";

type CorsMethod = "GET" | "HEAD" | "PUT" | "PATCH" | "POST" | "DELETE";

type CorsOptions = {
  methods?: CorsMethod[];
  /** Defaults to 5 mins */
  maxAge?: number;
  origin?: boolean | string;
  credentials?: boolean;
  exposedHeaders?: string[];
};

export async function apiCors(
  request: Request,
  response: Response,
  options: CorsOptions = { maxAge: 5 * 60 }
): Promise<Response> {
  if (hasCorsHeaders(response)) {
    return response;
  }

  return cors(request, response, options);
}

export function makeApiCors(
  request: Request,
  options: CorsOptions = { maxAge: 5 * 60 }
): (response: Response) => Promise<Response> {
  return (response: Response) => apiCors(request, response, options);
}

function hasCorsHeaders(response: Response) {
  return response.headers.has("access-control-allow-origin");
}
