import { z } from "zod";

export const AgentLoopMetadata = z.object({
  waitToken: z.object({
    id: z.string(),
    publicAccessToken: z.string(),
  }),
});

export type AgentLoopMetadata = z.infer<typeof AgentLoopMetadata>;

export const CSVRowPayload = z.object({
  header: z.string().describe("The header of the CSV dataset"),
  row: z.string().describe("The row to handle"),
  url: z.string().url().describe("The URL of the CSV dataset"),
});

export type CSVRowPayload = z.infer<typeof CSVRowPayload>;

export const RowEnrichmentResult = z.object({
  basicInfo: z.object({
    name: z.string().describe("The name of the row"),
    email: z.string().email().describe("The email of the row"),
    firstName: z.string().optional().describe("The first name of the row"),
    lastName: z.string().optional().describe("The last name of the row"),
    preferredName: z.string().optional().describe("The preferred name of the row"),
  }),
  companyInfo: z.object({
    name: z.string().describe("The name of the company"),
    industry: z.string().describe("The industry of the company"),
  }),
  socialInfo: z.object({
    twitter: z.string().url().optional().describe("The Twitter URL of the person"),
    linkedin: z.string().url().optional().describe("The LinkedIn URL of the person"),
    facebook: z.string().url().optional().describe("The Facebook URL of the person"),
    instagram: z.string().url().optional().describe("The Instagram URL of the person"),
  }),
});

export type RowEnrichmentResult = z.infer<typeof RowEnrichmentResult>;

export const QueryApproval = z.object({
  approved: z.boolean().describe("Whether the query has been approved"),
});

export type QueryApproval = z.infer<typeof QueryApproval>;
