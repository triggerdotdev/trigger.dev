import { parse } from "cookie";
import { type ResizableSnapshot } from "~/components/primitives/Resizable";
import { logger } from "./logger.server";

export async function getResizableSnapshot(
  request: Request,
  id: string
): Promise<ResizableSnapshot | undefined> {
  try {
    const cookieHeader = request.headers.get("Cookie");
    if (!cookieHeader) {
      return undefined;
    }

    const cookies = parse(cookieHeader);
    const cookieValue = cookies[id];

    if (cookieValue) {
      try {
        const parsedValue = JSON.parse(cookieValue) as any;
        if (typeof parsedValue === "object" && "status" in parsedValue) {
          return parsedValue as ResizableSnapshot;
        }
      } catch (parseError) {
        logger.error("getResizableSnapshot() error parsing cookie value:", {
          parseError,
          cookieValue,
        });
      }
    }

    return undefined;
  } catch (error) {
    logger.error("getResizableSnapshot() error:", {
      error,
    });
    return undefined;
  }
}
