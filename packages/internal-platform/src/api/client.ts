import { z } from "zod";
import { UpdateWorkflowRun, WorkflowMetadata } from "../schemas";
import fetch from "node-fetch";

export class InternalApiClient {
  #apiKey: string;
  #baseUrl: string;

  constructor(apiKey: string, baseUrl: string) {
    this.#apiKey = apiKey;
    this.#baseUrl = `${baseUrl}/api/v1/internal`;
  }

  async whoami(): Promise<{ organizationId: string; env: string }> {
    const ResponseSchema = z.object({
      organizationId: z.string(),
      env: z.string(),
    });

    const Response401Schema = z.object({
      error: z.string(),
    });

    const response = await fetch(this.#apiUrl("/whoami"), {
      method: "GET",
      headers: this.#headers(),
    });

    if (response.ok) {
      const rawBody = await response.json();

      return ResponseSchema.parse(rawBody);
    }

    if (response.status === 401) {
      const rawBody = await response.json();
      const body = Response401Schema.parse(rawBody);

      throw new Error(body.error);
    }

    throw new Error(
      `[${response.status}] Something went wrong: ${response.statusText}`
    );
  }

  async registerWorkflow(workflow: WorkflowMetadata) {
    const responseSchema = z.object({
      id: z.string(),
    });

    const validationResponseSchema = z.object({
      error: z.string(),
    });

    const response = await fetch(this.#apiUrl(`/workflows/${workflow.id}`), {
      method: "PUT",
      headers: this.#headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(workflow),
    });

    if (response.ok) {
      const rawBody = await response.json();

      return responseSchema.parse(rawBody);
    }

    if (response.status === 400) {
      const rawBody = await response.json();
      const body = validationResponseSchema.parse(rawBody);

      throw new Error(body.error);
    }

    throw new Error(
      `[${response.status}] Something went wrong: ${response.statusText}`
    );
  }

  async startWorkflowRun(workflowId: string, runId: string) {
    const validationResponseSchema = z.object({
      error: z.string(),
    });

    const response = await fetch(
      this.#apiUrl(`/workflows/${workflowId}/runs/${runId}`),
      {
        method: "PUT",
        headers: this.#headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ status: "RUNNING" }),
      }
    );

    if (response.ok) {
      return true;
    }

    if (response.status === 400) {
      const rawBody = await response.json();
      const body = validationResponseSchema.parse(rawBody);

      throw new Error(body.error);
    }

    throw new Error(
      `[${response.status}] Something went wrong: ${response.statusText}`
    );
  }

  #apiUrl = (path: string) => `${this.#baseUrl}${path}`;
  #headers = (additionalHeaders?: Record<string, string>) => ({
    Accept: "application/json",
    Authorization: `Bearer ${this.#apiKey}`,
    ...(additionalHeaders ?? {}),
  });
}
