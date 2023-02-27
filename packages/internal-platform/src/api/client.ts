import { z } from "zod";
import { UpdateWorkflowRun, WorkflowMetadata } from "../schemas";
import fetch from "node-fetch";
import { Logger } from "../logger";

export class InternalApiClient {
  #apiKey: string;
  #baseUrl: string;
  #v2BaseUrl: string;
  #logger: Logger;

  constructor(apiKey: string, baseUrl: string) {
    this.#apiKey = apiKey;
    this.#baseUrl = `${baseUrl}/api/v1/internal`;
    this.#v2BaseUrl = `${baseUrl}/api/v2/internal`;
    this.#logger = new Logger("trigger.dev [internal-api]");
  }

  async whoami(): Promise<{ organizationId: string; env: string }> {
    const ResponseSchema = z.object({
      organizationId: z.string(),
      env: z.string(),
      organizationSlug: z.string(),
    });

    const Response401Schema = z.object({
      error: z.string(),
    });

    this.#logger.debug("whoami", {
      url: this.#apiUrl("/whoami"),
      method: "GET",
    });

    const response = await fetch(this.#apiUrl("/whoami"), {
      method: "GET",
      headers: this.#headers(),
    });

    if (response.ok) {
      const rawBody = await response.json();

      this.#logger.debug("whoami ok response", { rawBody });

      return ResponseSchema.parse(rawBody);
    }

    if (response.status === 401) {
      const rawBody = await response.json();

      this.#logger.debug("whoami 401 response", { rawBody });

      const body = Response401Schema.parse(rawBody);

      throw new Error(body.error);
    }

    this.#logger.debug("whoami failure response", { status: response.status });

    throw new Error(
      `[${response.status}] Something went wrong: ${response.statusText}`
    );
  }

  async registerWorkflow(workflow: WorkflowMetadata) {
    const responseSchema = z.object({
      workflow: z.object({
        id: z.string(),
        slug: z.string(),
      }),
      environment: z.object({
        id: z.string(),
        slug: z.string(),
      }),
      organization: z.object({
        id: z.string(),
        slug: z.string(),
      }),
      url: z.string(),
    });

    const validationResponseSchema = z.object({
      error: z.string(),
    });

    const response = await fetch(this.#v2ApiUrl(`/workflows/${workflow.id}`), {
      method: "PUT",
      headers: this.#headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(workflow),
    });

    if (response.ok) {
      const rawBody = await response.json();

      const body = responseSchema.parse(rawBody);

      return { ...body, isNew: response.status === 201 };
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
  #v2ApiUrl = (path: string) => `${this.#v2BaseUrl}${path}`;
  #headers = (additionalHeaders?: Record<string, string>) => ({
    Accept: "application/json",
    Authorization: `Bearer ${this.#apiKey}`,
    ...(additionalHeaders ?? {}),
  });
}
