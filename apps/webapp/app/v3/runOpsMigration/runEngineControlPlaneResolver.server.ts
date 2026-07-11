import type {
  ControlPlaneResolver as EngineControlPlaneResolver,
  ResolvedAuthenticatedEnv,
  ResolvedEngineEnv,
  ResolvedWorkerVersion,
} from "@internal/run-engine";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import type { ControlPlaneResolver as AppControlPlaneResolver } from "./controlPlaneResolver.server";
import { controlPlaneResolver } from "./controlPlaneResolver.server";

/**
 * Adapter that presents the webapp's cross-DB cached ControlPlaneResolver as the
 * run-engine `ControlPlaneResolver` seam. Injected in `runEngine.server.ts`, it replaces the
 * default `PassthroughControlPlaneResolver` so the engine's dequeue/waitpoint/checkpoint/delayTTL
 * reads resolve the control-plane half cache-first instead of via an in-DB join.
 *
 * `resolveEnv` maps the app `ResolvedEnv` (widened to carry the concurrency + nested ids the engine
 * needs) onto `ResolvedEngineEnv`. `resolveWorkerVersion` forwards the env `type` so the app
 * resolver runs the full run-engine dequeue dispatch (DEV most-recent / MANAGED promotion).
 */
export class RunEngineControlPlaneResolver implements EngineControlPlaneResolver {
  readonly #resolver: AppControlPlaneResolver;

  constructor(resolver: AppControlPlaneResolver) {
    this.#resolver = resolver;
  }

  async resolveEnv(environmentId: string): Promise<ResolvedEngineEnv | null> {
    const env = await this.#resolver.resolveEnv(environmentId);

    if (!env) {
      return null;
    }

    return {
      id: env.id,
      type: env.type,
      archivedAt: env.archivedAt,
      maximumConcurrencyLimit: env.maximumConcurrencyLimit,
      concurrencyLimitBurstFactor: env.concurrencyLimitBurstFactor,
      projectId: env.projectId,
      organizationId: env.organizationId,
      project: { id: env.projectId },
      organization: { id: env.organizationId },
    };
  }

  async resolveWorkerVersion(args: {
    environmentId: string;
    type: RuntimeEnvironmentType;
    workerId?: string;
  }): Promise<ResolvedWorkerVersion | null> {
    return this.#resolver.resolveWorkerVersion({
      environmentId: args.environmentId,
      backgroundWorkerId: args.workerId,
      type: args.type,
    });
  }

  async resolveAuthenticatedEnv(environmentId: string): Promise<ResolvedAuthenticatedEnv | null> {
    // Delegate to the cache-first, split-aware app resolver (like resolveEnv/resolveWorkerVersion):
    // its authenticated-env slot now carries `git`. Keep the deleted-project guard the engine relies
    // on — a deleted project's env must not resolve.
    const environment = await this.#resolver.resolveAuthenticatedEnv(environmentId);

    if (!environment || environment.project.deletedAt !== null) {
      return null;
    }

    return environment;
  }

  async assertEnvExists(environmentId: string): Promise<void> {
    await this.#resolver.assertEnvExists(environmentId);
  }
}

// Module-level singleton over the app resolver singleton.
export const runEngineControlPlaneResolver = new RunEngineControlPlaneResolver(
  controlPlaneResolver
);
