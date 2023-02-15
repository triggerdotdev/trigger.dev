import type { DisplayProperties } from "@trigger.dev/integration-sdk";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { integrationsClient } from "~/services/integrationsClient.server";
import { getVersion1Integrations } from "./integrations.server";

export class DisplayPropertiesPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async requestProperties(
    service: string,
    name: string,
    params: any
  ): Promise<DisplayProperties> {
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

      return {
        title: "Unknown integration",
      };
    }

    //no v1 integration with requests found, try v2
    try {
      const displayProperties = await integrationsClient.displayProperties({
        service,
        name,
        params,
      });

      if (!displayProperties) {
        return {
          title: "Unknown integration",
        };
      }

      return displayProperties;
    } catch (e) {
      console.error(e);
      return {
        title: "Unknown integration",
      };
    }
  }
}
