import { createCookie } from "@remix-run/node";
import { z } from "zod";

const resizableSettings = createCookie("react-resizable-panels:layout", {
  maxAge: 60 * 60 * 365, // 1 year
});

const ResizableConfig = z
  .object({ run: z.array(z.number()).optional() })
  .default({ run: undefined });
type ResizableConfig = z.infer<typeof ResizableConfig>;

export async function getResizableRunSettings(request: Request): Promise<ResizableConfig> {
  const cookieHeader = request.headers.get("Cookie");
  const cookie = (await resizableSettings.parse(cookieHeader)) || undefined;
  if (!cookie) {
    return {
      run: undefined,
    };
  }

  return ResizableConfig.parse(cookie);
}
