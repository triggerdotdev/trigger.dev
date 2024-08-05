import { apiClientManager } from "../apiClientManager-api.js";

export type UsageClientOptions = {
  token: string;
  baseUrl: string;
};

export type UsageEvent = {
  durationMs: number;
};

export class UsageClient {
  constructor(
    private readonly url: string,
    private jwt: string
  ) {}

  async sendUsageEvent(event: UsageEvent): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        body: JSON.stringify(event),
        headers: {
          "content-type": "application/json",
          "x-trigger-jwt": this.jwt,
          accept: "application/json",
          authorization: `Bearer ${apiClientManager.accessToken}`, // this is used to renew the JWT
        },
      });

      if (response.ok) {
        const renewedJwt = response.headers.get("x-trigger-jwt");

        if (renewedJwt) {
          this.jwt = renewedJwt;
        }
      }
    } catch (error) {
      console.error(`Failed to send usage event: ${error}`);
    }
  }
}
