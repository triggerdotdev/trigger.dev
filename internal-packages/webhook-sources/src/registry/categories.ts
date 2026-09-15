/**
 * Canonical provider categories: the single source of truth for a category's display label and the
 * order categories appear in (the console groups the picker by these). A registry entry's `category`
 * must be one of these ids; the webapp renders `categoryLabel(id)` rather than deriving anything.
 */
export const WEBHOOK_CATEGORIES = [
  { id: "ai-platform", label: "AI & ML" },
  { id: "voice", label: "Voice AI" },
  { id: "communication", label: "Communication" },
  { id: "email", label: "Email" },
  { id: "marketing", label: "Marketing" },
  { id: "support", label: "Support" },
  { id: "crm", label: "CRM" },
  { id: "pm", label: "Project Management" },
  { id: "productivity", label: "Productivity" },
  { id: "calendar-scheduling", label: "Calendar & Scheduling" },
  { id: "forms", label: "Forms" },
  { id: "e-signature", label: "E-Signature" },
  { id: "storage", label: "Storage" },
  { id: "data", label: "Data" },
  { id: "source-control", label: "Source Control" },
  { id: "ci-cd", label: "CI / CD" },
  { id: "hosting-infra", label: "Hosting & Infra" },
  { id: "observability", label: "Observability" },
  { id: "auth-identity", label: "Auth & Identity" },
  { id: "payments", label: "Payments" },
  { id: "billing", label: "Billing & Subscriptions" },
  { id: "commerce", label: "Commerce" },
  { id: "fintech", label: "Fintech & Banking" },
] as const;

export type WebhookCategoryId = (typeof WEBHOOK_CATEGORIES)[number]["id"];

const LABEL = new Map<string, string>(WEBHOOK_CATEGORIES.map((c) => [c.id, c.label]));
const ORDER = new Map<string, number>(WEBHOOK_CATEGORIES.map((c, i) => [c.id, i]));

/** Display label for a category id, falling back to the id itself for anything unmapped. */
export function categoryLabel(id: string): string {
  return LABEL.get(id) ?? id;
}

/** Sort index for a category id (unmapped categories sort last). */
export function categoryOrder(id: string): number {
  return ORDER.get(id) ?? Number.MAX_SAFE_INTEGER;
}
