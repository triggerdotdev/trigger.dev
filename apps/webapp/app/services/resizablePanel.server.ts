import { createCookie, createCookieSessionStorage } from "@remix-run/node";
import { type ResizableSnapshot } from "~/components/primitives/Resizable";
import { logger } from "./logger.server";

export async function getResizableSnapshot(
  request: Request,
  id: string
): Promise<ResizableSnapshot> {
  const cookie = createCookie(id, {
    httpOnly: false,
    secure: false,
    path: "/",
  });

  try {
    const header = request.headers.get("Cookie");
    const value = await cookie.parse(header);
    logger.info("getResizableSnapshot", { id, value, cookie });
    if (value != null && "status" in value) {
      return value as ResizableSnapshot;
    } else {
      return undefined;
    }
  } catch (error) {
    console.error(error);
    return undefined;
  }
}
