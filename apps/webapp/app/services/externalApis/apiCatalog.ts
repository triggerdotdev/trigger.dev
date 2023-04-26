import { airtable } from "./apis/airtable";
import { slack } from "./apis/slack";
import type { ExternalAPI } from "./types";

export const apis: Record<string, ExternalAPI> = { slack, airtable };
