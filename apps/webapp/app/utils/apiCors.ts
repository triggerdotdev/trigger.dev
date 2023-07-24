import { cors } from "remix-utils";

type CorsMethod = "GET" | "HEAD" | "PUT" | "PATCH" | "POST" | "DELETE";

type CorsOptions = {
  methods?: CorsMethod[];
  /** Defaults to 5 mins */
  maxAge?: number;
};

export function apiCors(
  request: Request,
  response: Response,
  options: CorsOptions = { maxAge: 5 * 60 }
): Promise<Response> {
  return cors(request, response, options);
}
