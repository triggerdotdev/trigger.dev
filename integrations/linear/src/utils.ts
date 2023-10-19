import { CommentEvent, IssueEvent, WebhookPayload } from "./schemas";
import { GetLinearPayload } from "./types";
import { LinearDocument as L } from "@linear/sdk";

export type QueryVariables = {
  after: string;
  before: string;
  first: number;
  includeArchived: boolean;
  last: number;
  orderBy: L.PaginationOrderBy;
};

export type Nullable<T> = Partial<{
  [K in keyof T]: T[K] | null;
}>;

export const onCommentProperties = (payload: GetLinearPayload<CommentEvent>) => {
  return [
    { label: "Comment ID", text: payload.data.id },
    { label: "Issue ID", text: payload.data.issueId },
    { label: "Issue Title", text: payload.data.issue.title, url: payload.url ?? undefined },
  ];
};

export const onIssueProperties = (payload: GetLinearPayload<IssueEvent>) => {
  return [
    { label: "Issue ID", text: payload.data.id },
    {
      label: "Issue",
      text: `[${payload.data.team.key}-${payload.data.number}] ${payload.data.title}`,
      url: payload.url ?? undefined,
    },
  ];
};

export const queryProperties = (query: Nullable<QueryVariables>) => {
  return [
    ...(query.after ? [{ label: "After", text: query.after }] : []),
    ...(query.before ? [{ label: "Before", text: query.before }] : []),
    ...(query.first ? [{ label: "First", text: String(query.first) }] : []),
    ...(query.last ? [{ label: "Last", text: String(query.last) }] : []),
    ...(query.orderBy ? [{ label: "Order by", text: query.orderBy }] : []),
    ...(query.includeArchived
      ? [{ label: "Include archived", text: String(query.includeArchived) }]
      : []),
  ];
};

export const updatedFromProperties = (payload: WebhookPayload) => {
  if (payload.action !== "update") return [];
  return [
    {
      label: "Updated Keys",
      text: Object.keys(payload.updatedFrom)
        .filter((key) => !["editedAt", "updatedAt"].includes(key))
        .join(", "),
    },
  ];
};
