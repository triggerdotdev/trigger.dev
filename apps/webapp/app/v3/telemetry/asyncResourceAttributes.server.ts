import { z } from "zod";
import type { ResourceAttributes } from "@opentelemetry/resources";
import {
  SEMRESATTRS_AWS_ECS_CLUSTER_ARN,
  SEMRESATTRS_AWS_ECS_CONTAINER_ARN,
  SEMRESATTRS_AWS_ECS_LAUNCHTYPE,
  SEMRESATTRS_AWS_ECS_TASK_ARN,
  SEMRESATTRS_AWS_ECS_TASK_FAMILY,
  SEMRESATTRS_AWS_ECS_TASK_REVISION,
  SEMRESATTRS_AWS_LOG_GROUP_NAMES,
  SEMRESATTRS_AWS_LOG_STREAM_NAMES,
  SEMRESATTRS_CLOUD_AVAILABILITY_ZONE,
  SEMRESATTRS_CLOUD_PLATFORM,
  SEMRESATTRS_CLOUD_PROVIDER,
  SEMRESATTRS_CLOUD_REGION,
  SEMRESATTRS_CONTAINER_NAME,
  SEMRESATTRS_CONTAINER_ID,
  SEMRESATTRS_CONTAINER_IMAGE_NAME,
  SEMRESATTRS_CONTAINER_IMAGE_TAG,
  CLOUDPLATFORMVALUES_AWS_ECS,
  CLOUDPROVIDERVALUES_AWS,
} from "@opentelemetry/semantic-conventions";
import { tryCatch } from "@trigger.dev/core/utils";
import { logger } from "~/services/logger.server";

// Minimal schema for ECS task metadata
const ECSTaskMetadataSchema = z.object({
  Cluster: z.string().optional(),
  TaskARN: z.string().optional(),
  Family: z.string().optional(),
  Revision: z.string().optional(),
  AvailabilityZone: z.string().optional(),
  LaunchType: z.string().optional(),
  ServiceName: z.string().optional(),
});

const ECSLogOptions = z.object({
  "awslogs-group": z.string().optional(),
  "awslogs-region": z.string().optional(),
  "awslogs-stream": z.string().optional(),
  mode: z.string().optional(),
});

// Minimal schema for container metadata
const ECSContainerMetadataSchema = z.object({
  DockerId: z.string().optional(),
  Name: z.string().optional(),
  Image: z.string().optional(),
  ImageID: z.string().optional(),
  ContainerARN: z.string().optional(),
  LogOptions: ECSLogOptions.optional(),
});

// Cache for ECS metadata to avoid repeated fetches
let ecsMetadataCache: ResourceAttributes | null = null;

/**
 * Fetches ECS task metadata from the v4 endpoint
 */
async function fetchECSTaskMetadata(metadataUri: string): Promise<ResourceAttributes> {
  const [error, response] = await tryCatch(
    fetch(`${metadataUri}/task`, {
      signal: AbortSignal.timeout(5000),
    })
  );

  if (error) {
    logger.warn("Failed to fetch ECS task metadata", { error });
    return {};
  }

  if (!response.ok) {
    logger.warn("ECS task metadata fetch failed", { status: response.status });
    return {};
  }

  const [jsonError, taskJson] = await tryCatch(response.json());
  if (jsonError) {
    logger.warn("Failed to parse ECS task metadata", { error: jsonError });
    return {};
  }

  const parseResult = ECSTaskMetadataSchema.safeParse(taskJson);
  if (!parseResult.success) {
    logger.warn("ECS task metadata validation issues", { issues: parseResult.error.issues });
    return {};
  }

  const taskData = parseResult.data;
  const attributes: ResourceAttributes = {};

  if (taskData.TaskARN) {
    attributes[SEMRESATTRS_AWS_ECS_TASK_ARN] = taskData.TaskARN;
  }

  if (taskData.Cluster) {
    attributes[SEMRESATTRS_AWS_ECS_CLUSTER_ARN] = taskData.Cluster;
  }

  if (taskData.LaunchType) {
    attributes[SEMRESATTRS_AWS_ECS_LAUNCHTYPE] = taskData.LaunchType;
  }

  if (taskData.Family) {
    attributes[SEMRESATTRS_AWS_ECS_TASK_FAMILY] = taskData.Family;
  }

  if (taskData.Revision) {
    attributes[SEMRESATTRS_AWS_ECS_TASK_REVISION] = taskData.Revision;
  }

  if (taskData.AvailabilityZone) {
    attributes[SEMRESATTRS_CLOUD_AVAILABILITY_ZONE] = taskData.AvailabilityZone;
  }

  if (taskData.ServiceName) {
    // Custom attribute for ECS service name
    attributes["aws.ecs.service.name"] = taskData.ServiceName;
  }

  return attributes;
}

/**
 * Fetches ECS container metadata from the v4 endpoint
 */
async function fetchECSContainerMetadata(metadataUri: string): Promise<ResourceAttributes> {
  const [error, response] = await tryCatch(
    fetch(metadataUri, {
      signal: AbortSignal.timeout(5000),
    })
  );

  if (error) {
    logger.warn("Failed to fetch ECS container metadata", { error });
    return {};
  }

  if (!response.ok) {
    logger.warn("ECS container metadata fetch failed", { status: response.status });
    return {};
  }

  const [jsonError, containerJson] = await tryCatch(response.json());
  if (jsonError) {
    logger.warn("Failed to parse ECS container metadata", { error: jsonError });
    return {};
  }

  const parseResult = ECSContainerMetadataSchema.safeParse(containerJson);
  if (!parseResult.success) {
    logger.warn("ECS container metadata validation issues", { issues: parseResult.error.issues });
    return {};
  }

  const containerData = parseResult.data;
  const attributes: ResourceAttributes = {};

  if (containerData.Name) {
    attributes[SEMRESATTRS_CONTAINER_NAME] = containerData.Name;
  }

  if (containerData.DockerId) {
    attributes[SEMRESATTRS_CONTAINER_ID] = containerData.DockerId;
  }

  if (containerData.Image) {
    const [name, tag] = containerData.Image.split(":");

    if (name) {
      attributes[SEMRESATTRS_CONTAINER_IMAGE_NAME] = name;
    }

    if (tag) {
      attributes[SEMRESATTRS_CONTAINER_IMAGE_TAG] = tag;
    }
  }

  if (containerData.ImageID) {
    // Custom attribute for image ID
    attributes["container.image.id"] = containerData.ImageID;
  }

  if (containerData.ContainerARN) {
    attributes[SEMRESATTRS_AWS_ECS_CONTAINER_ARN] = containerData.ContainerARN;
  }

  const logOptions = containerData.LogOptions;
  if (logOptions?.["awslogs-group"]) {
    attributes[SEMRESATTRS_AWS_LOG_GROUP_NAMES] = [logOptions["awslogs-group"]];
  }
  if (logOptions?.["awslogs-stream"]) {
    attributes[SEMRESATTRS_AWS_LOG_STREAM_NAMES] = [logOptions["awslogs-stream"]];
  }
  if (logOptions?.mode) {
    // Custom attribute for log mode
    attributes["aws.log.mode"] = [logOptions.mode];
  }

  return attributes;
}

/**
 * Fetches ECS metadata from the Task Metadata Endpoint V4
 * Returns resource attributes for OpenTelemetry
 */
async function fetchECSMetadata(metadataUri: string): Promise<ResourceAttributes> {
  // Return cached metadata if available
  if (ecsMetadataCache !== null) {
    return ecsMetadataCache;
  }

  if (!metadataUri) {
    // Not running in ECS
    ecsMetadataCache = {};
    return ecsMetadataCache;
  }

  // Fetch task metadata and CloudWatch logs config in parallel
  const [taskAttributes, containerAttributes] = await Promise.all([
    fetchECSTaskMetadata(metadataUri),
    fetchECSContainerMetadata(metadataUri),
  ]);

  const attributes: ResourceAttributes = {
    [SEMRESATTRS_CLOUD_PROVIDER]: CLOUDPROVIDERVALUES_AWS,
    [SEMRESATTRS_CLOUD_PLATFORM]: CLOUDPLATFORMVALUES_AWS_ECS,
    ...taskAttributes,
    ...containerAttributes,
  };

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (region) {
    attributes[SEMRESATTRS_CLOUD_REGION] = region;
  }

  logger.info("🔦 Fetched ECS metadata", { attributes });

  ecsMetadataCache = attributes;
  return attributes;
}

/**
 * Fetches async resource attributes
 * Designed to be used with the Resource constructor's asyncAttributesPromise parameter
 *
 * Usage:
 * ```
 * new Resource(
 *   { [SEMRESATTRS_SERVICE_NAME]: 'my-service' },
 *   getAsyncResourceAttributes()
 * )
 * ```
 */
export async function getAsyncResourceAttributes(): Promise<ResourceAttributes> {
  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;

  if (!metadataUri) {
    return {};
  }

  return fetchECSMetadata(metadataUri);
}
