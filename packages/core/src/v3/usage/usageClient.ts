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
    private readonly jwt: string
  ) {}

  async sendUsageEvent(event: UsageEvent): Promise<void> {
    try {
      await fetch(this.url, {
        method: "POST",
        body: JSON.stringify(event),
        headers: {
          "content-type": "application/json",
          "x-trigger-jwt": this.jwt,
          accept: "application/json",
        },
      });
    } catch (error) {
      console.error(`Failed to send usage event: ${error}`);
    }
  }
}
