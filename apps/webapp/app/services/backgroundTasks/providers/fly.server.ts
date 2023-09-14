import {
  BackgroundTask,
  BackgroundTaskArtifact,
  BackgroundTaskMachineStatus,
  BackgroundTaskProviderStrategy,
} from "@trigger.dev/database";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { ZodResponse, zodfetch } from "~/zodfetch.server";
import { BackgroundTaskProvider, ExternalMachine, ExternalMachineConfig } from "./types";
import retry from "async-retry";
import AsyncRetry from "async-retry";

const FlyAppSchema = z.object({
  name: z.string(),
  organization: z.object({
    name: z.string(),
    slug: z.string(),
  }),
  status: z.string(),
});

const FlyCreateAppSchema = z.object({
  app_name: z.string(),
  org_slug: z.string(),
  network: z.string().optional(),
});

const FlyCheckStatusSchema = z.object({
  name: z.string(),
  output: z.string(),
  status: z.string(),
  updated_at: z.coerce.date().optional(),
});

const FlyMachineGuestSchema = z.object({
  cpu_kind: z.enum(["shared", "dedicated"]),
  cpus: z.number(),
  memory_mb: z.number(),
});

const FlyMachineMetricsSchema = z.object({
  path: z.string(),
  port: z.number(),
});

const FlyMachineMountSchema = z.object({
  encrypted: z.boolean().optional(),
  name: z.string().optional(),
  path: z.string(),
  volume: z.string(),
  size_gb: z.number().optional(),
});

const FlyMachineProcessSchema = z.object({
  cmd: z.array(z.string()).optional(),
  entrypoint: z.string().optional(),
  env: z.record(z.string()).default({}),
  exec: z.array(z.string()).optional(),
  user: z.string().optional(),
});

const FlyMachineRestartSchema = z.object({
  max_retries: z.number().optional(),
  policy: z.string().optional(),
});

const FlyMachineHTTPHeaderSchema = z.array(
  z.object({ name: z.string(), values: z.array(z.string()) })
);

const FlyMachineCheckSchema = z.object({
  grace_period: z.string().optional(),
  headers: z.array(FlyMachineHTTPHeaderSchema).default([]),
  interval: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  port: z.number().optional(),
  protocol: z.string().optional(),
  timeouyt: z.string().optional(),
  tls_server_name: z.string().optional(),
  tls_skip_verify: z.boolean().optional(),
  type: z.string().optional(),
});

const FlyMachineServiceConcurrencySchema = z.object({
  hard_limit: z.number().optional(),
  soft_limit: z.number().optional(),
  type: z.string(),
});

const FlyHTTPOptionsSchema = z.object({
  compress: z.boolean().optional(),
  response: z
    .object({
      headers: z.record(z.string()).default({}),
    })
    .optional(),
});

const FlyMachinePortSchema = z.object({
  end_port: z.number(),
  force_https: z.boolean().optional(),
  handlers: z.array(z.string()).default([]),
  http_options: FlyHTTPOptionsSchema.optional(),
});

const FlyMachineServiceSchema = z.object({
  autostart: z.boolean().optional(),
  autostop: z.boolean().optional(),
  checks: z.array(FlyMachineCheckSchema).default([]),
  concurrency: FlyMachineServiceConcurrencySchema,
  force_instance_description: z.string().optional(),
  force_instance_key: z.string().optional(),
  internal_port: z.number().optional(),
  min_machines_running: z.number().optional(),
  ports: z.array(FlyMachinePortSchema).default([]),
  protocol: z.string().optional(),
});

const FlyMachineStaticSchema = z.object({
  guest_path: z.string(),
  url_prefix: z.string(),
});

const FlyMachineStopConfigSchema = z.object({
  signal: z.string().optional(),
  timeout: z.string().optional(),
});

const FlyMachineConfigSchema = z.object({
  auto_destroy: z.boolean().optional(),
  env: z.record(z.string()).default({}),
  checks: z.record(FlyMachineCheckSchema).default({}),
  metadata: z.record(z.string()).default({}),
  guest: FlyMachineGuestSchema,
  image: z.string(),
  metrics: FlyMachineMetricsSchema.optional(),
  mounts: z.array(FlyMachineMountSchema).default([]),
  processes: z.array(FlyMachineProcessSchema).default([]),
  restart: FlyMachineRestartSchema.default({}),
  services: z.array(FlyMachineServiceSchema).default([]),
  standbys: z.array(z.string()).default([]),
  statics: z.array(FlyMachineStaticSchema).default([]),
  stop_config: FlyMachineStopConfigSchema.optional(),
});

const FlyMachineImageRefSchema = z.object({
  digest: z.string(),
  registry: z.string(),
  repository: z.string(),
  tag: z.string(),
  labels: z.record(z.string()).nullable().default({}),
});

const FlyMachineStateSchema = z.enum([
  "created",
  "starting",
  "started",
  "stopping",
  "stopped",
  "destroying",
  "destroyed",
  "replacing",
]);

const FlyMachineEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  source: z.string(),
  timestamp: z.coerce.date(),
  request: z.any(),
});

const FlyMachineSchema = z.object({
  id: z.string(),
  instance_id: z.string(),
  name: z.string(),
  nonce: z.string().optional(),
  private_ip: z.string(),
  region: z.string(),
  state: FlyMachineStateSchema,
  config: FlyMachineConfigSchema,
  checks: z.array(FlyCheckStatusSchema).optional(),
  events: z.array(FlyMachineEventSchema).default([]),
  image_ref: FlyMachineImageRefSchema,
  created_at: z.coerce.date(),
  updated_at: z.coerce.date().optional(),
});

const FlyVolumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  region: z.string(),
  size_gb: z.number(),
  encrypted: z.boolean(),
  created_at: z.coerce.date(),
  attached_machine_id: z.string().nullable().optional(),
  attached_alloc_id: z.string().nullable().optional(),
  blocks: z.number(),
  block_size: z.number(),
  blocks_free: z.number(),
  blocks_avail: z.number(),
  fstype: z.string(),
  host_dedication_key: z.string().nullable().optional(),
});

const FlyCreateVolumeSchema = z.object({
  name: z.string(),
  region: z.string(),
  size_gb: z.number(),
  machines_only: z.boolean().optional(),
  encrypted: z.boolean().optional(),
});

const FlyCreateMachineSchema = z.object({
  name: z.string(),
  lease_ttl: z.number().optional(),
  region: z.string(),
  config: FlyMachineConfigSchema,
  skip_launch: z.boolean().optional(),
  skip_service_registration: z.boolean().optional(),
});

export class FlyBackgroundTaskProvider implements BackgroundTaskProvider {
  private readonly _logger = logger.child("FlyBackgroundTaskProvider");

  get name(): BackgroundTaskProviderStrategy {
    return "FLY_IO";
  }

  get registry(): string {
    return "registry.fly.io";
  }

  constructor(
    private readonly url: string,
    private readonly org: string,
    private readonly token: string
  ) {}

  get defaultRegion(): string {
    return "iad";
  }

  async prepareArtifact(
    task: BackgroundTask,
    artifact: BackgroundTaskArtifact
  ): Promise<{ image: string; tag: string }> {
    // Check that the app has been created
    const app = await this.#getApp(this.#appNameForTask(task));

    if (app) {
      return {
        image: app.name,
        tag: artifact.version,
      };
    }

    // Create the app
    const created = await this.#createApp({
      app_name: this.#appNameForTask(task),
      network: this.#networkNameForTask(task),
      org_slug: this.org,
    });

    if (!created) {
      throw new Error("Failed to create app");
    }

    return {
      image: this.#appNameForTask(task),
      tag: artifact.version,
    };
  }

  async getMachineForTask(id: string, task: BackgroundTask): Promise<ExternalMachine | undefined> {
    const response = await this.#fetch(
      FlyMachineSchema,
      `/v1/apps/${this.#appNameForTask(task)}/machines/${id}`
    );

    if (!response.ok) {
      return;
    }

    return this.#flyMachineToExternalMachine(response.data);
  }

  async getMachinesForTask(task: BackgroundTask): Promise<Array<ExternalMachine>> {
    const response = await this.#fetch(
      z.array(FlyMachineSchema),
      `/v1/apps/${this.#appNameForTask(task)}/machines`
    );

    if (!response.ok) {
      return [];
    }

    return response.data.map((machine) => this.#flyMachineToExternalMachine(machine));
  }

  async createMachineForTask(
    id: string,
    task: BackgroundTask,
    config: ExternalMachineConfig
  ): Promise<ExternalMachine> {
    // We have to create a volume first
    const volume = await this.#createVolume(this.#appNameForTask(task), {
      name: id,
      region: config.region,
      size_gb: config.diskSize,
      encrypted: true,
      machines_only: true,
    });

    const machine = await this.#createMachine(this.#appNameForTask(task), {
      name: id,
      region: config.region,
      config: {
        image: config.image,
        env: config.env,
        guest: {
          cpu_kind: "shared",
          cpus: config.cpus,
          memory_mb: config.memory,
        },
        auto_destroy: false,
        mounts: [
          {
            volume: volume.id,
            path: "/data",
          },
        ],
      },
    });

    return this.#flyMachineToExternalMachine(machine);
  }

  async cleanupForTask(task: BackgroundTask): Promise<void> {
    const volumes = await this.#listVolumes(this.#appNameForTask(task));

    if (!volumes) {
      return;
    }

    // Destroy any volumn created more than 30 seconds ago that doesn't have a machine attached
    const destroyableVolumes = volumes.filter(
      (volume) =>
        volume.created_at.getTime() < Date.now() - 30 * 1000 &&
        !volume.attached_machine_id &&
        !volume.attached_alloc_id &&
        volume.state !== "pending_destroy"
    );

    this._logger.debug("cleanupForTask", {
      volumesToDestroy: destroyableVolumes.length,
    });

    for (const volume of destroyableVolumes) {
      await this.#destroyVolume(this.#appNameForTask(task), volume.id);
    }
  }

  #flyMachineToExternalMachine(flyMachine: z.output<typeof FlyMachineSchema>): ExternalMachine {
    return {
      id: flyMachine.id,
      status: this.#flyStateToStatus(flyMachine.state),
      data: flyMachine,
    };
  }

  #flyStateToStatus(state: z.infer<typeof FlyMachineStateSchema>): BackgroundTaskMachineStatus {
    const mappings: Record<z.infer<typeof FlyMachineStateSchema>, BackgroundTaskMachineStatus> = {
      created: "CREATED",
      starting: "STARTING",
      started: "STARTED",
      stopping: "STOPPING",
      stopped: "STOPPED",
      destroying: "DESTROYING",
      destroyed: "DESTROYED",
      replacing: "REPLACING",
    };

    return mappings[state];
  }

  async #getApp(appName: string) {
    const response = await this.#fetch(FlyAppSchema, `/v1/apps/${appName}`);

    if (!response.ok) {
      return;
    }

    return response.data;
  }

  async #createApp(body: z.input<typeof FlyCreateAppSchema>) {
    const response = await this.#fetch(z.any(), "/v1/apps", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return response.ok;
  }

  async #createMachine(
    appName: string,
    body: z.input<typeof FlyCreateMachineSchema>
  ): Promise<z.output<typeof FlyMachineSchema>> {
    const response = await this.#fetch(
      FlyMachineSchema,
      `/v1/apps/${appName}/machines`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      {
        retries: 5,
      }
    );

    if (!response.ok) {
      throw new Error("Failed to create machine");
    }

    return response.data;
  }

  async #createVolume(
    appName: string,
    body: z.input<typeof FlyCreateVolumeSchema>
  ): Promise<z.output<typeof FlyVolumeSchema>> {
    const response = await this.#fetch(
      FlyVolumeSchema,
      `/v1/apps/${appName}/volumes`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      {
        retries: 5,
      }
    );

    if (!response.ok) {
      throw new Error("Failed to create volume");
    }

    return response.data;
  }

  async #listVolumes(
    appName: string
  ): Promise<Array<z.output<typeof FlyVolumeSchema>> | undefined> {
    const response = await this.#fetch(z.array(FlyVolumeSchema), `/v1/apps/${appName}/volumes`, {
      method: "GET",
    });

    if (!response.ok) {
      return;
    }

    return response.data;
  }

  async #destroyVolume(appName: string, id: string): Promise<boolean> {
    const response = await this.#fetch(z.any(), `/v1/apps/${appName}/volumes/${id}`, {
      method: "DELETE",
    });

    return response.ok;
  }

  async #fetch<TResponseSchema extends z.ZodTypeAny>(
    schema: TResponseSchema,
    path: string,
    requestInit?: RequestInit,
    retryOptions?: AsyncRetry.Options
  ): Promise<ZodResponse<TResponseSchema>> {
    const headers = new Headers(requestInit?.headers ?? {});

    // Add the common headers
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Accept", "application/json");
    headers.set("User-Agent", "Trigger.dev/2.1.0");

    if (requestInit?.body) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }

    if (retryOptions) {
      return await retry(
        async (bail) => {
          const response = await zodfetch(schema, `${this.url}${path}`, {
            ...requestInit,
            headers,
          });

          if (!response.ok) {
            if (response.status === 429 || response.status >= 500) {
              throw new Error(
                `[${response.status}] Request ${
                  requestInit?.method ?? "GET"
                } ${path} failed: ${JSON.stringify(response.error)}`
              );
            }

            bail(
              new Error(
                `[${response.status}] Request ${
                  requestInit?.method ?? "GET"
                } ${path} failed: ${JSON.stringify(response.error)}`
              )
            );
            return response;
          }

          return response;
        },
        {
          ...retryOptions,
          onRetry: (e, attempt) => {
            this._logger.debug("fetch.retry", {
              url: `${this.url}${path}`,
              attempt,
              response: {
                ok: response.ok,
                status: response.status,
                error: response.ok ? undefined : response.error,
                err: {
                  message: e.message,
                  stack: e.stack,
                },
              },
            });
          },
        }
      );
    }

    const response = await zodfetch(schema, `${this.url}${path}`, {
      ...requestInit,
      headers,
    });

    this._logger.debug("fetch", {
      url: `${this.url}${path}`,
      response: {
        ok: response.ok,
        status: response.status,
        error: response.ok ? undefined : response.error,
      },
    });

    return response;
  }

  #appNameForTask(task: BackgroundTask): string {
    return `${task.id}-${task.slug}`;
  }

  #networkNameForTask(task: BackgroundTask): string {
    return task.projectId;
  }
}
