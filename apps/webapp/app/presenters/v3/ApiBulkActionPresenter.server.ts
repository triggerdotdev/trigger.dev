import {
  type BulkActionGroup,
  type BulkActionStatus,
  type BulkActionType,
} from "@trigger.dev/database";
import { z } from "zod";
import { BasePresenter } from "./basePresenter.server";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export const ApiBulkActionListSearchParams = z.object({
  "page[size]": z.coerce.number().int().positive().min(1).max(MAX_PAGE_SIZE).optional(),
  "page[after]": z.string().optional(),
  "page[before]": z.string().optional(),
});

export type ApiBulkActionListSearchParams = z.infer<typeof ApiBulkActionListSearchParams>;

type BulkActionListCursor = {
  createdAt: Date;
  id: string;
};

type BulkActionRow = Pick<
  BulkActionGroup,
  | "id"
  | "friendlyId"
  | "name"
  | "status"
  | "type"
  | "createdAt"
  | "completedAt"
  | "totalCount"
  | "successCount"
  | "failureCount"
>;

export class ApiBulkActionPresenter extends BasePresenter {
  public async list(environmentId: string, searchParams: ApiBulkActionListSearchParams) {
    const pageSize = searchParams["page[size]"] ?? DEFAULT_PAGE_SIZE;
    const after = searchParams["page[after]"];
    const before = searchParams["page[before]"];

    if (after && before) {
      throw new Error("Only one of page[after] or page[before] can be provided");
    }

    const cursor = decodeCursor(after ?? before);
    const direction = before ? "backward" : "forward";

    const where = {
      environmentId,
      ...(cursor
        ? direction === "forward"
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            }
        : {}),
    };

    const rows = await this._replica.bulkActionGroup.findMany({
      select: bulkActionSelect,
      where,
      orderBy:
        direction === "forward"
          ? [{ createdAt: "desc" }, { id: "desc" }]
          : [{ createdAt: "asc" }, { id: "asc" }],
      take: pageSize + 1,
    });

    const hasMore = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);
    const dataRows = direction === "forward" ? pageRows : [...pageRows].reverse();

    const first = dataRows.at(0);
    const last = dataRows.at(-1);

    return {
      data: dataRows.map(apiBulkActionObject),
      pagination: {
        next: last && (hasMore || direction === "backward") ? encodeCursor(last) : undefined,
        previous:
          first &&
          ((direction === "forward" && Boolean(after)) || (direction === "backward" && hasMore))
            ? encodeCursor(first)
            : undefined,
      },
    };
  }
}

export const bulkActionSelect = {
  id: true,
  friendlyId: true,
  name: true,
  status: true,
  type: true,
  createdAt: true,
  completedAt: true,
  totalCount: true,
  successCount: true,
  failureCount: true,
} as const;

export function apiBulkActionObject(row: BulkActionRow) {
  return {
    id: row.friendlyId,
    name: row.name ?? undefined,
    type: row.type as BulkActionType,
    status: row.status as BulkActionStatus,
    counts: {
      total: row.totalCount,
      success: row.successCount,
      failure: row.failureCount,
    },
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? undefined,
  };
}

function encodeCursor(row: Pick<BulkActionRow, "createdAt" | "id">) {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.getTime(), id: row.id })).toString(
    "base64url"
  );
}

function decodeCursor(cursor: string | undefined): BulkActionListCursor | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== "number" || typeof parsed.id !== "string") {
      throw new Error("Invalid cursor");
    }

    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    throw new Error("Invalid cursor");
  }
}
