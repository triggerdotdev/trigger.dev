import { BulkActionPresenter } from "~/presenters/v3/BulkActionPresenter.server";
import { ApiBulkActionPresenter } from "~/presenters/v3/ApiBulkActionPresenter.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import {
  renderBulkActionDetail,
  renderBulkActionId,
  renderBulkActionRow,
} from "./format/bulkActions";
import { renderCursor } from "./format/logFields";
import { BulkActionIdInput, ListBulkActionsInput } from "./schemas/bulkActions";

export const bulkActionsTools: McpToolDefinition[] = [
  defineReadTool({
    name: "list_bulk_actions",
    title: "List Bulk Actions",
    description:
      "List the bulk actions (cancel or replay many runs at once) of an environment, newest first. Pass the returned cursor to list older ones.",
    shape: ListBulkActionsInput.shape,
    auth: { action: "read", subject: "runs" },
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      let result;
      try {
        result = await new ApiBulkActionPresenter().list(environment.id, {
          "page[size]": input.limit,
          "page[after]": input.cursor,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "Invalid cursor") {
          return errorResult("Invalid cursor");
        }
        throw error;
      }

      if (result.data.length === 0) return textResult("No bulk actions found.");

      const lines = [
        `Found ${result.data.length} bulk action${result.data.length === 1 ? "" : "s"}:`,
        ...result.data.map((row, i) => renderBulkActionRow(row, i + 1)),
      ];
      const next = result.pagination.next && renderCursor(result.pagination.next);
      if (next) {
        lines.push(`More bulk actions exist. Pass cursor ${next} to list older ones.`);
      }
      return textResult(lines.join("\n"));
    },
  }),
  defineReadTool({
    name: "get_bulk_action",
    title: "Get Bulk Action",
    description:
      "Get a bulk action: its type, status, run counts, the filter or run IDs it selected, and when it was created and completed. The ID starts with bulk_",
    shape: BulkActionIdInput.shape,
    auth: { action: "read", subject: "runs" },
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      let detail;
      try {
        detail = await new BulkActionPresenter().call({
          environmentId: environment.id,
          bulkActionId: input.bulkActionId,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "Bulk action not found") {
          return errorResult(`Bulk action ${renderBulkActionId(input.bulkActionId)} not found`);
        }
        throw error;
      }

      return textResult(renderBulkActionDetail(detail));
    },
  }),
];
