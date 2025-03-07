import type { EndpointIndexSource } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { PerformEndpointIndexService } from "./performEndpointIndexService.server";

export class IndexEndpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    id: string,
    source: EndpointIndexSource = "INTERNAL",
    reason?: string,
    sourceData?: any
  ) {
    const endpointIndex = await this.#prismaClient.endpointIndex.create({
      data: {
        endpointId: id,
        status: "PENDING",
        source,
        reason,
        sourceData,
      },
    });

    const performEndpointIndexService = new PerformEndpointIndexService();
    return await performEndpointIndexService.call(endpointIndex.id);
  }
}
