import { packetRequiresOffloading, stringifyIO } from "@trigger.dev/core/v3";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService } from "./baseService.server";
import { env } from "~/env.server";
import { handleMetadataPacket } from "~/utils/packets";
import { type RunTemplateData } from "../taskRunTemplate";

export class TaskRunTemplateService extends BaseService {
  public async call(environment: AuthenticatedEnvironment, data: RunTemplateData) {
    const { triggerSource } = data;

    switch (triggerSource) {
      case "STANDARD": {
        const packet = { data: JSON.stringify(data.payload), dataType: "application/json" };

        const { needsOffloading } = packetRequiresOffloading(
          packet,
          env.TASK_PAYLOAD_OFFLOAD_THRESHOLD
        );

        if (needsOffloading) {
          // we currently disallow large payloads in task run templates
          throw new Error("Payload too large");
        }

        const metadataPacket = data.metadata
          ? handleMetadataPacket(
              data.metadata,
              "application/json",
              env.TASK_RUN_METADATA_MAXIMUM_SIZE
            )
          : undefined;

        const taskRunTemplate = await this._prisma.taskRunTemplate.create({
          data: {
            taskSlug: data.taskIdentifier,
            triggerSource: "STANDARD",
            label: data.label,
            payload: packet.data,
            payloadType: packet.dataType,
            metadata: metadataPacket?.data,
            metadataType: metadataPacket?.dataType,
            queue: data.queue,
            ttlSeconds: data.ttlSeconds,
            concurrencyKey: data.concurrencyKey,
            maxAttempts: data.maxAttempts,
            maxDurationSeconds: data.maxDurationSeconds,
            tags: data.tags ?? [],
            machinePreset: data.machine,
            projectId: environment.projectId,
            organizationId: environment.organizationId,
          },
        });

        return taskRunTemplate;
      }
      case "SCHEDULED": {
        const payload = {
          scheduleId: "sched_1234",
          type: "IMPERATIVE",
          timestamp: data.timestamp,
          lastTimestamp: data.lastTimestamp,
          timezone: data.timezone,
          externalId: data.externalId,
          upcoming: [],
        };
        const payloadPacket = await stringifyIO(payload);

        const taskRunTemplate = await this._prisma.taskRunTemplate.create({
          data: {
            taskSlug: data.taskIdentifier,
            triggerSource: "SCHEDULED",
            label: data.label,
            payload: payloadPacket.data,
            payloadType: payloadPacket.dataType,
            queue: data.queue,
            ttlSeconds: data.ttlSeconds,
            concurrencyKey: data.concurrencyKey,
            maxAttempts: data.maxAttempts,
            maxDurationSeconds: data.maxDurationSeconds,
            tags: data.tags ?? [],
            machinePreset: data.machine,
            projectId: environment.projectId,
            organizationId: environment.organizationId,
          },
        });

        return taskRunTemplate;
      }
      default: {
        triggerSource satisfies never;
        throw new Error("Invalid trigger source");
      }
    }
  }
}
