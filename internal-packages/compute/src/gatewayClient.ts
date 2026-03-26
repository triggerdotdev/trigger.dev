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
    const url = `${this.opts.gatewayUrl}/api/templates`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.opts.authToken) {
      headers["Authorization"] = `Bearer ${this.opts.authToken}`;
    }

    const signal = options?.signal ?? AbortSignal.timeout(this.opts.timeoutMs);

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");
      throw new Error(`Gateway template creation failed (${response.status}): ${errorBody}`);
    }

    return { accepted: response.status === 202 };
  }
}
