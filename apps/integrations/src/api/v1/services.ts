import { IntegrationAuthentication } from "core/authentication/types";
import { Service } from "core/service/types";
import { Request, Response } from "express";
import { catalog } from "integrations/catalog";

type ServiceMetadata = {
  name: string;
  service: string;
  version: string;
  live: boolean;
  authentication: IntegrationAuthentication;
};

export async function handleServices(req: Request, res: Response) {
  const servicesMetadata: Record<string, ServiceMetadata> = {};
  Object.entries(catalog.services).forEach(([key, service]) => {
    const metadata = omitExtraInfo(service);
    servicesMetadata[key] = metadata;
  });

  res.send(
    JSON.stringify({
      services: servicesMetadata,
    })
  );
}

function omitExtraInfo(service: Service): ServiceMetadata {
  const { actions, retryableStatusCodes, ...rest } = service;
  return rest;
}
