import { z } from "zod";

export const feedbackTypes = {
  bug: {
    label: "Bug report",
    labelTypeId: "lt_01HB920BTPFS36KH1JT9C36YVY",
    threadTitle: "Web app: Bug report",
  },
  feature: {
    label: "Feature request",
    labelTypeId: "lt_01HB920BV8CJGYXVE15WWN6P07",
    threadTitle: "Web app: Feature request",
  },
  help: {
    label: "Help me out",
    labelTypeId: "lt_01KTVCAPZY5ZJ0SS4ACMXWYYT3",
    threadTitle: "Web app: Help me out",
  },
  enterprise: {
    label: "Enterprise enquiry",
    labelTypeId: "lt_01K7PF5EV2877EH4SZYB667FW4",
    threadTitle: "Web app: Enterprise enquiry",
  },
  feedback: {
    label: "General feedback",
    labelTypeId: "lt_01HB920BSRZ3RA1ETHBVEB5ST2",
    threadTitle: "Web app: General feedback",
  },
  concurrency: {
    label: "Increase my concurrency",
    labelTypeId: "lt_01KTVCCY2PDE5V6WV2PQ8N85K2",
    threadTitle: "Web app: Increase my concurrency",
  },
  region: {
    label: "Suggest a new region",
    labelTypeId: "lt_01KTVCDPYYBW6KS9H5V8MTQ0GG",
    threadTitle: "Web app: Suggest a new region",
  },
  hipaa: {
    label: "HIPAA BAA request",
    labelTypeId: "lt_01KS54WBRYKE6DY369KPK2SS4W",
    threadTitle: "Web app: HIPAA BAA request",
  },
} as const satisfies Record<string, { label: string; labelTypeId?: string; threadTitle: string }>;

export type FeedbackType = keyof typeof feedbackTypes;

const feedbackTypeLiterals = Object.keys(feedbackTypes).map((key) => z.literal(key));

const feedbackType = z.union(
  [feedbackTypeLiterals[0], feedbackTypeLiterals[1], ...feedbackTypeLiterals.slice(2)],
  {
    error: "Must be a valid feedback type",
  }
);

export const schema = z.object({
  path: z.string(),
  feedbackType,
  message: z.string().min(10, "Must be at least 10 characters"),
});
