import {
    LogLevel,
    Logger,
    CancelJobSchema,
    TriggerManagementResponseSchema as ResponseSchema,
    CancelJobSchemaInput,
    JobRunsSchema,
    JobRunsSchemaInput,
    RerunJobSchema,
    RerunJobSchemaInput,
    TestJobSchema,
    TestJobSchemaInput,
    JobRunsResponseSchema
} from "@trigger.dev/core";
import fetch, { type RequestInit } from "node-fetch";
import { z } from "zod";

export type ApiClientOptions = {
    personalAccessToken: string;
    apiUrl?: string;
    logLevel?: LogLevel;
};

export class TriggerManagementAPI {
    #apiUrl: string;
    #options: ApiClientOptions;
    #logger: Logger;

    constructor(options: ApiClientOptions) {
        this.#options = options;
        this.#apiUrl = this.#options.apiUrl ?? process.env.TRIGGER_API_URL ?? "https://api.trigger.dev";
        this.#logger = new Logger("trigger.dev", this.#options.logLevel);
    }

    async cancelJob(input: CancelJobSchemaInput) {
        const { runId } = CancelJobSchema.parse(input)
        const apiKey = this.#options.personalAccessToken;

        this.#logger.debug("canceling job", {
            runId,
        });

        const response = await zodfetch(ResponseSchema, `${this.#apiUrl}/api/v2/cancel-job`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ runId }),
        });
        return response
    }

    async getJobRuns(input: JobRunsSchemaInput) {
        const { organizationSlug, projectSlug, jobSlug, status, environment } = JobRunsSchema.parse(input)

        const apiKey = this.#options.personalAccessToken;

        this.#logger.debug("getting job runs", {
            organizationSlug,
            projectSlug,
            jobSlug,
            status,
            environment,
        });

        const response = await zodfetch(JobRunsResponseSchema, `${this.#apiUrl}/api/v2/job-runs`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                organizationSlug,
                projectSlug,
                jobSlug,
                status,
                environment,
            }),
        });

        return response;
    }

    async rerunJob(input: RerunJobSchemaInput) {
        const { runId, intent } = RerunJobSchema.parse(input)

        const apiKey = this.#options.personalAccessToken;

        this.#logger.debug("rerunning job", {
            runId,
            intent,
        });

        const response = await zodfetch(ResponseSchema, `${this.#apiUrl}/api/v2/rerun-job`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ runId, intent }),
        });

        return response
    }

    async testJob(input: TestJobSchemaInput) {
        const { environmentId, payload, versionId } = TestJobSchema.parse(input)

        const apiKey = this.#options.personalAccessToken;

        this.#logger.debug("testing job", {
            environmentId,
            payload,
            versionId,
        });

        const response = await zodfetch(ResponseSchema, `${this.#apiUrl}/api/v2/test-job`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ environmentId, payload, versionId }),
        });
        return response
    }

}

async function zodfetch<TResponseBody extends any, TOptional extends boolean = false>(
    schema: z.Schema<TResponseBody>,
    url: string,
    requestInit?: RequestInit,
    options?: {
        errorMessage?: string;
        optional?: TOptional;
    }
): Promise<TOptional extends true ? TResponseBody | undefined : TResponseBody> {
    const response = await fetch(url, requestInit);

    if (
        (!requestInit || requestInit.method === "GET") &&
        response.status === 404 &&
        options?.optional
    ) {
        // @ts-ignore
        return;
    }

    if (response.status >= 400 && response.status < 500) {
        const text = await response.text();
        console.log(text);
        const body = JSON.parse(text)
        throw new Error(body.error);
    }

    if (response.status !== 200) {
        throw new Error(
            options?.errorMessage ?? `Failed to fetch ${url}, got status code ${response.status}`
        );
    }

    const jsonBody = await response.json();
    return schema.parse(jsonBody);
}

