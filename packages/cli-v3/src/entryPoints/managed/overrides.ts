export type Metadata = {
  TRIGGER_RUN_ID: string | undefined;
  TRIGGER_SNAPSHOT_ID: string | undefined;
  TRIGGER_SUPERVISOR_API_PROTOCOL: string | undefined;
  TRIGGER_SUPERVISOR_API_DOMAIN: string | undefined;
  TRIGGER_SUPERVISOR_API_PORT: number | undefined;
  TRIGGER_WORKER_INSTANCE_NAME: string | undefined;
  TRIGGER_HEARTBEAT_INTERVAL_SECONDS: number | undefined;
  TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS: number | undefined;
  TRIGGER_SUCCESS_EXIT_CODE: number | undefined;
  TRIGGER_FAILURE_EXIT_CODE: number | undefined;
  TRIGGER_RUNNER_ID: string | undefined;
};

export class MetadataClient {
  private readonly url: URL;

  constructor(url: string) {
    this.url = new URL(url);
  }

  async getEnvOverrides(): Promise<Metadata | null> {
    try {
      const response = await fetch(new URL("/env", this.url));
      return response.json();
    } catch (error) {
      console.error("Failed to fetch metadata", { error });
      return null;
    }
  }
}
