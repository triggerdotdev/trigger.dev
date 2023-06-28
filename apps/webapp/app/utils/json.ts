import { z } from "zod";

export function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

export function safeJsonZodParse<T>(
  schema: z.Schema<T>,
  json: string
): z.SafeParseReturnType<unknown, T> | undefined {
  const parsed = safeJsonParse(json);

  if (parsed === null) {
    return;
  }

  return schema.safeParse(parsed);
}

export async function safeJsonFromResponse(response: Response) {
  const json = await response.text();
  return safeJsonParse(json);
}

export async function safeBodyFromResponse<T>(
  response: Response,
  schema: z.Schema<T>
): Promise<T | undefined> {
  const json = await response.text();
  const unknownJson = safeJsonParse(json);

  if (!unknownJson) {
    return;
  }

  const parsedJson = schema.safeParse(unknownJson);

  if (parsedJson.success) {
    return parsedJson.data;
  }
}
