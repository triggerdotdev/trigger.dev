import { describe, expect, it, vi } from "vitest";
import type { CliApiClient } from "../../apiClient.js";
import { createProjectWithFreePlanFallback } from "./common.js";

const project = { name: "My project", externalRef: "proj_123" };
const planRequired = {
  success: false,
  statusCode: 402,
  error: "You must select a plan for this organization before creating projects.",
};

function fakeClient(
  createResponses: unknown[],
  activateResponse: unknown = { success: true, data: { plan: "free" } }
) {
  const createProject = vi.fn();
  for (const response of createResponses) createProject.mockResolvedValueOnce(response);
  const activateFreePlan = vi.fn().mockResolvedValue(activateResponse);
  return {
    client: { createProject, activateFreePlan } as unknown as CliApiClient,
    createProject,
    activateFreePlan,
  };
}

describe("createProjectWithFreePlanFallback", () => {
  it("does not activate a plan when the project is created", async () => {
    const { client, activateFreePlan } = fakeClient([{ success: true, data: project }]);

    const response = await createProjectWithFreePlanFallback(client, "acme", "My project");

    expect(response.success).toBe(true);
    expect(activateFreePlan).not.toHaveBeenCalled();
  });

  it("activates the Free plan and retries when a plan is required", async () => {
    const { client, createProject } = fakeClient([planRequired, { success: true, data: project }]);

    const response = await createProjectWithFreePlanFallback(client, "acme", "My project");

    expect(response.success).toBe(true);
    expect(createProject).toHaveBeenCalledTimes(2);
  });

  it("retries when another command already activated the organization", async () => {
    const { client } = fakeClient([planRequired, { success: true, data: project }], {
      success: false,
      statusCode: 409,
      error: "Organization is already activated",
    });

    const response = await createProjectWithFreePlanFallback(client, "acme", "My project");

    expect(response.success).toBe(true);
  });

  it("returns the plan error when activation is unavailable", async () => {
    const { client, createProject } = fakeClient([planRequired], {
      success: false,
      statusCode: 404,
      error: "Not found",
    });

    const response = await createProjectWithFreePlanFallback(client, "acme", "My project");

    expect(response).toEqual(planRequired);
    expect(createProject).toHaveBeenCalledTimes(1);
  });
});
