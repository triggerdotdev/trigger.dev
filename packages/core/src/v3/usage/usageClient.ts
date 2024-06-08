export type UsageClientOptions = {
  token: string;
  baseUrl: string;
};

export type UsageEvent = {
  source: string;
  subject: string;
  type: string;
  id?: string;
  time?: Date;
  data?: Record<string, unknown>;
};

export class UsageClient {
  constructor(private readonly options: UsageClientOptions) {}

  async sendUsageEvent(event: UsageEvent): Promise<void> {
    const body = {
      specversion: "1.0",
      id: event.id ?? globalThis.crypto.randomUUID(),
      source: event.source,
      type: event.type,
      time: (event.time ?? new Date()).toISOString(),
      subject: event.subject,
      datacontenttype: "application/json",
      data: event.data,
    };

    const url = `${this.baseUrl}/api/v1/events`;

    try {
      await fetch(url, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/cloudevents+json",
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
      });
    } catch {}
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  private get token(): string {
    return this.options.token;
  }
}
