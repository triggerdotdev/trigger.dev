import { z } from "zod";

const ResizableConfig = z
  .object({ layout: z.array(z.number()).optional() })
  .default({ layout: undefined });
type ResizableConfig = z.infer<typeof ResizableConfig>;

function getCookieValue(cookieHeader: string | null, cookieName: string): ResizableConfig {
  const cookieValue = cookieHeader?.split(`${cookieName}=`)[1]?.split(";")[0];
  if (!cookieValue) {
    return { layout: undefined };
  }
  try {
    const json = JSON.parse(cookieValue);
    return ResizableConfig.parse(json);
  } catch (e) {
    return { layout: undefined };
  }
}

//run page
const runResizableName = "resizable-panels:run";

export async function getResizableRunSettings(request: Request): Promise<ResizableConfig> {
  const cookieHeader = request.headers.get("Cookie");
  return getCookieValue(cookieHeader, runResizableName);
}

export async function setResizableRunSettings(document: Document, layout: number[]) {
  document.cookie = `${runResizableName}=${JSON.stringify({ layout })}`;
}
