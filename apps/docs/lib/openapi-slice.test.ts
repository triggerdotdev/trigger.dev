import { describe, expect, it } from "vitest";
import { operationSlice } from "./openapi-slice";

describe("operationSlice", () => {
  // Catches: API reference pages reaching agents (.md, llms-full, MCP, Ask AI) with no endpoint in them.
  it("keeps the operation and only the components it references", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "API" },
      servers: [{ url: "https://api.trigger.dev" }],
      security: [{ secretKey: [] }],
      paths: {
        "/api/v1/runs": {
          get: {
            description: "List runs",
            responses: { 200: { $ref: "#/components/responses/Runs" } },
          },
          post: { description: "other" },
        },
      },
      components: {
        responses: { Runs: { content: { schema: { $ref: "#/components/schemas/Run" } } } },
        schemas: {
          Run: { properties: { parent: { $ref: "#/components/schemas/Run" } } },
          Unused: {},
        },
        securitySchemes: { secretKey: { type: "http" }, other: { type: "apiKey" } },
      },
    };
    const slice = operationSlice(spec, "/api/v1/runs", "get")!;
    expect(slice.paths).toEqual({ "/api/v1/runs": { get: spec.paths["/api/v1/runs"].get } });
    expect(slice.components).toEqual({
      responses: { Runs: spec.components.responses.Runs },
      schemas: { Run: spec.components.schemas.Run },
      securitySchemes: { secretKey: { type: "http" } },
    });
    expect(operationSlice(spec, "/api/v1/runs", "delete")).toBeUndefined();
  });

  // Catches: an API page's markdown using {deploymentId} without declaring it, when the path declares it.
  it("keeps the path's shared parameters and their components", () => {
    const parameters = [{ $ref: "#/components/parameters/deploymentId" }];
    const spec = {
      paths: { "/api/v1/deployments/{deploymentId}": { parameters, get: { description: "Get" } } },
      components: { parameters: { deploymentId: { name: "deploymentId", in: "path" } } },
    };
    const slice = operationSlice(spec, "/api/v1/deployments/{deploymentId}", "get")!;
    expect(slice.paths).toEqual({
      "/api/v1/deployments/{deploymentId}": { parameters, get: { description: "Get" } },
    });
    expect(slice.components).toEqual(spec.components);
  });
});
