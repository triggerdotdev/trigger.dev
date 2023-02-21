import type { DisplayProperties } from "@trigger.dev/integration-sdk";
import { DisplayPropertiesSchema } from "@trigger.dev/integration-sdk";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getVersion1Integrations } from "~/models/integrations.server";

export class DisplayPropertiesPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async requestProperties(
    service: string,
    name: string,
    params: any,
    displayProperties?: any
  ): Promise<DisplayProperties> {
    //first check if there are display properties already
    if (displayProperties) {
      const parsed = DisplayPropertiesSchema.safeParse(displayProperties);
      if (parsed.success) return parsed.data;
      return {
        title: "Unknown integration",
      };
    }

    //first check the v1 integrations
    const v1Integrations = getVersion1Integrations(true);
    const v1Integration = v1Integrations.find(
      (s) => s.metadata.service === service
    );

    if (v1Integration && v1Integration.requests) {
      const displayProperties = v1Integration.requests.displayProperties(
        name,
        params
      );

      if (displayProperties) {
        return displayProperties;
      }
    }

    return {
      title: "Unknown integration",
    };
  }
}
