import type {
  TemplateCreateRequest,
  TemplateCreateResponse,
  InstanceCreateRequest,
  InstanceCreateResponse,
  InstanceSnapshotRequest,
  SnapshotRestoreRequest,
} from "./types.js";

export type ComputeClientOptions = {
  gatewayUrl: string;
  authToken?: string;
  timeoutMs: number;
};

export class ComputeClient {
  readonly templates: TemplatesNamespace;
  readonly instances: InstancesNamespace;
  readonly snapshots: SnapshotsNamespace;

  constructor(private opts: ComputeClientOptions) {
    const http = new HttpTransport(opts);
    this.templates = new TemplatesNamespace(http);
    this.instances = new InstancesNamespace(http);
    this.snapshots = new SnapshotsNamespace(http);
  }
}

// ── HTTP transport (shared plumbing) ─────────────────────────────────────────

type RequestOptions = {
  signal?: AbortSignal;
};

class HttpTransport {
  constructor(private opts: ComputeClientOptions) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.authToken) {
      h["Authorization"] = `Bearer ${this.opts.authToken}`;
    }
    return h;
  }

  private signal(options?: RequestOptions): AbortSignal {
    return options?.signal ?? AbortSignal.timeout(this.opts.timeoutMs);
  }

  async post<T = unknown>(path: string, body: unknown, options?: RequestOptions): Promise<T | undefined> {
    const url = `${this.opts.gatewayUrl}${path}`;

    const response = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
      signal: this.signal(options),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");
      throw new ComputeClientError(response.status, errorBody, url);
    }

    // 202 Accepted or 204 No Content - no body to parse
    if (response.status === 202 || response.status === 204) {
      return undefined;
    }

    return (await response.json()) as T;
  }

  async delete(path: string, options?: RequestOptions): Promise<void> {
    const url = `${this.opts.gatewayUrl}${path}`;

    const response = await fetch(url, {
      method: "DELETE",
      headers: this.headers,
      signal: this.signal(options),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");
      throw new ComputeClientError(response.status, errorBody, url);
    }
  }
}

// ── Error ────────────────────────────────────────────────────────────────────

export class ComputeClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string
  ) {
    super(`Compute gateway request failed (${status}): ${body}`);
    this.name = "ComputeClientError";
  }
}

// ── Namespaces ───────────────────────────────────────────────────────────────

class TemplatesNamespace {
  constructor(private http: HttpTransport) {}

  async create(
    req: TemplateCreateRequest,
    options?: RequestOptions
  ): Promise<TemplateCreateResponse | undefined> {
    // Background mode returns 202 with no body; sync/callback mode returns
    // the full result. Caller decides whether to inspect.
    return this.http.post<TemplateCreateResponse>("/api/templates", req, options);
  }
}

class InstancesNamespace {
  constructor(private http: HttpTransport) {}

  async create(
    req: InstanceCreateRequest,
    options?: RequestOptions
  ): Promise<InstanceCreateResponse> {
    const result = await this.http.post<InstanceCreateResponse>("/api/instances", req, options);
    if (!result) {
      throw new Error("Compute gateway returned no instance body");
    }
    return result;
  }

  async delete(runnerId: string, options?: RequestOptions): Promise<void> {
    return this.http.delete(`/api/instances/${runnerId}`, options);
  }

  async snapshot(
    runnerId: string,
    req: InstanceSnapshotRequest,
    options?: RequestOptions
  ): Promise<void> {
    await this.http.post(`/api/instances/${runnerId}/snapshot`, req, options);
  }
}

class SnapshotsNamespace {
  constructor(private http: HttpTransport) {}

  async restore(
    snapshotId: string,
    req: SnapshotRestoreRequest,
    options?: RequestOptions
  ): Promise<void> {
    await this.http.post(`/api/snapshots/${snapshotId}/restore`, req, options);
  }
}
