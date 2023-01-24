import * as github from "./github";
export * as github from "./github";
import * as slack from "./slack";
export * as slack from "./slack";
import * as shopify from "./shopify";
export * as shopify from "./shopify";
import * as resend from "./resend";
import { InternalIntegration } from "./types";
export * as resend from "./resend";
export * from "./types";

export const integrations: Record<string, InternalIntegration> = {
  github,
  slack,
  shopify,
  resend,
};
