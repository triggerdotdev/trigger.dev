import { json, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import {
  addFavorite,
  removeFavorite,
  renameFavorite,
} from "~/services/dashboardPreferences.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";

const FavoriteLabel = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(64));

const RequestSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("add"),
    id: z.string().min(1).max(64),
    // App-relative URL only ("/..." but not protocol-relative "//...")
    url: z
      .string()
      .min(1)
      .max(2048)
      .refine((url) => url.startsWith("/") && !url.startsWith("//"), {
        message: "URL must be app-relative",
      }),
    label: FavoriteLabel,
    icon: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(64)
      .optional(),
  }),
  z.object({
    intent: z.literal("remove"),
    id: z.string().min(1).max(64),
  }),
  z.object({
    intent: z.literal("rename"),
    id: z.string().min(1).max(64),
    label: FavoriteLabel,
  }),
]);

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  const formData = await request.formData();
  const result = RequestSchema.safeParse(Object.fromEntries(formData));

  if (!result.success) {
    return json({ success: false, error: "Invalid request data" }, { status: 400 });
  }

  // Errors come back as a response (never a throw, which would escalate a preferences write to
  // the error boundary); the side menu's optimistic entries revert when the fetcher settles.
  try {
    switch (result.data.intent) {
      case "add": {
        const { id, url, label, icon } = result.data;
        await addFavorite({ user, favorite: { id, url, label, icon } });
        break;
      }
      case "remove": {
        await removeFavorite({ user, id: result.data.id });
        break;
      }
      case "rename": {
        await renameFavorite({ user, id: result.data.id, label: result.data.label });
        break;
      }
    }
  } catch (error) {
    logger.error("Failed to update favorites", { error: String(error) });
    return json({ success: false, error: "Failed to save preferences" }, { status: 500 });
  }

  return json({ success: true });
}
