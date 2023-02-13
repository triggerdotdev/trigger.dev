import { Request, Response } from "express";
import { catalog } from "integrations/catalog";

export function handleAction(req: Request, res: Response) {
  const { service, action } = req.params;

  const matchingService = Object.values(catalog.services).find(
    (s) => s.service === service
  );

  if (!matchingService) {
    res
      .status(404)
      .send(JSON.stringify({ service, error: "Service not found" }));
    return;
  }

  res.send(`${service}/${action}`);
}
