import type { TemplateCreateRequest } from "./types.js";

export type ComputeGatewayClientOptions = {
  gatewayUrl: string;
  authToken?: string;
  timeoutMs: number;
};

export class ComputeGatewayClient {
  constructor(private opts: ComputeGatewayClientOptions) {}

  async createTemplate(
    req: TemplateCreateRequest,
    options?: { signal?: AbortSignal }
  ): Promise<{ accepted: boolean }> {
    const response = await this.#fetch(req, options?.signal);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");
      throw new Error(`Gateway template creation failed (${response.status}): ${errorBody}`);
    }

    return { accepted: response.status === 202 };
  }

  /**
   * Fire-and-forget template creation. Sends the request but does not
   * await the response, so no HTTP connection is held open.
   */
  createTemplateBackground(req: TemplateCreateRequest): void {
    this.#fetch(req).then(
      (response) => {
        if (!response.ok) {
          response.text().catch(() => {});
        }
      },
      () => {} // swallow network errors
    );
  }

  #fetch(req: TemplateCreateRequest, signal?: AbortSignal): Promise<Response> {
    const url = `${this.opts.gatewayUrl}/api/templates`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.opts.authToken) {
      headers["Authorization"] = `Bearer ${this.opts.authToken}`;
    }

    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
      signal: signal ?? AbortSignal.timeout(this.opts.timeoutMs),
    });
  }
}
