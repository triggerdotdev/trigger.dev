import { Action } from "core/action/types";
import { Service } from "core/service/types";
import { Request } from "express";
import { catalog } from "integrations/catalog";

type ServiceActionResult =
  | {
      success: true;
      service: Service;
      action: Action;
    }
  | {
      success: false;
      error: Record<string, any>;
    };

export function getServiceAction(
  params: Request["params"]
): ServiceActionResult {
  const { service, action } = params;

  const matchingService = Object.values(catalog.services).find(
    (s) => s.service === service
  );

  if (!matchingService) {
    return {
      success: false,
      error: { type: "missing_service", message: "Service not found", service },
    };
  }

  if (!matchingService.actions) {
    return {
      success: false,
      error: {
        type: "missing_action",
        message: "Action not found",
        service,
        action,
      },
    };
  }

  const matchingAction = Object.values(matchingService.actions).find(
    (a) => a.name === action
  );

  if (!matchingAction) {
    return {
      success: false,
      error: {
        type: "missing_action",
        message: "Action not found",
        service,
        action,
      },
    };
  }

  return { success: true, service: matchingService, action: matchingAction };
}
