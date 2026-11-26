import parseDuration from "parse-duration";
import { z } from "zod";
import { CommonProjectsInput } from "./common";

const MAX_PERIOD_MS = 365 * 24 * 60 * 60 * 1000;

const DEPLOYMENT_ID = /^(deployment_[0-9A-Za-z]{1,64}|[0-9A-Za-z_-]{8})$/;

export const GetDeploymentDetailsInput = CommonProjectsInput.omit({ environment: true }).extend({
  environment: z
    .enum(["staging", "prod", "preview"])
    .describe("The environment of the deployment")
    .default("prod"),
  deploymentId: z
    .string()
    .max(75)
    .regex(DEPLOYMENT_ID, "Must be a deployment_ id or an 8-character deploy short code")
    .describe("The deployment: its deployment_ id or its short code, as list_deploys shows them"),
});

export type GetDeploymentDetailsInput = z.output<typeof GetDeploymentDetailsInput>;

export const GetAgentDetailsInput = CommonProjectsInput.extend({
  agentSlug: z.string().min(1).max(128).describe("The agent's slug, as list_agents shows it"),
  period: z
    .string()
    .regex(/^[1-9]\d{0,5}[mhdw]$/, "Must be a duration like 30m, 1h, 7d or 2w")
    .refine((value) => (parseDuration(value) ?? Infinity) <= MAX_PERIOD_MS, "Must be at most 365d")
    .describe("How far back to count activity, like 1h, 7d or 30d, up to 365d. Defaults to 7d.")
    .default("7d"),
});

export type GetAgentDetailsInput = z.output<typeof GetAgentDetailsInput>;
