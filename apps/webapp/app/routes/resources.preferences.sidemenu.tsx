import { json, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import {
  SideMenuSectionIdSchema,
  type SideMenuSectionId,
} from "~/components/navigation/sideMenuTypes";
import {
  updateItemOrder,
  updateSideMenuCustomization,
  updateSideMenuPreferences,
} from "~/services/dashboardPreferences.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";

// Transforms form data string "true"/"false" to boolean, or undefined if not present
const booleanFromFormData = z
  .enum(["true", "false"])
  .transform((val) => val === "true")
  .optional();

const RequestSchema = z.object({
  isCollapsed: booleanFromFormData,
  width: z.coerce.number().int().positive().optional(),
  sectionId: SideMenuSectionIdSchema.optional(),
  sectionCollapsed: booleanFromFormData,
  // Generic item order fields
  organizationId: z.string().optional(),
  listId: z.string().optional(),
  itemOrder: z.string().optional(), // JSON-encoded string[]
  customization: z.string().optional(), // JSON-encoded CustomizationSchema
});

// Payload of the "Customize sidebar" modal. For the nullable fields, null resets to default and
// an absent field leaves the stored value unchanged.
const CustomizationSchema = z.object({
  sectionOrder: z.array(z.string().max(64)).max(50).nullish(),
  hiddenItems: z.record(z.string().max(64), z.boolean()).nullish(),
  sectionItemOrder: z.record(z.string().max(64), z.array(z.string().max(64)).max(100)).nullish(),
  favorites: z
    .array(z.object({ id: z.string().max(64), label: z.string().max(64) }))
    .max(100)
    .optional(),
  removedFavoriteIds: z.array(z.string().max(64)).max(100).optional(),
  knownItemIds: z.array(z.string().max(64)).max(500).optional(),
});

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  // Every writer below deliberately skips impersonated sessions so an admin's browsing can't
  // rewrite the customer's saved layout. That skip is a no-op, not a failed save, so report it as
  // success: it must not reach the callers that surface write failures to the user.
  if (user.isImpersonating) {
    return json({ success: true });
  }

  const formData = await request.formData();
  const rawData = Object.fromEntries(formData);

  const result = RequestSchema.safeParse(rawData);
  if (!result.success) {
    return json({ success: false, error: "Invalid request data" }, { status: 400 });
  }

  // Handle a "Customize sidebar" modal submit
  if (result.data.customization) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.data.customization);
    } catch {
      parsed = null;
    }
    const customizationResult = CustomizationSchema.safeParse(parsed);
    if (!customizationResult.success) {
      return json({ success: false, error: "Invalid request data" }, { status: 400 });
    }
    const {
      sectionOrder,
      hiddenItems,
      sectionItemOrder,
      favorites,
      removedFavoriteIds,
      knownItemIds,
    } = customizationResult.data;
    // The modal keeps its "Confirm" pending until this responds, so failures must come back as a
    // response (never a throw, which would escalate a preferences write to the error boundary).
    try {
      const updated = await updateSideMenuCustomization({
        user,
        sectionOrder,
        hiddenItems,
        sectionItemOrder,
        favorites,
        removedFavoriteIds,
        knownItemIds,
      });
      // undefined means nothing was written (impersonating, or the user row is gone)
      if (!updated) {
        return json({ success: false, error: "Failed to save preferences" }, { status: 500 });
      }
    } catch (error) {
      logger.error("Failed to save sidebar customization", { error: String(error) });
      return json({ success: false, error: "Failed to save preferences" }, { status: 500 });
    }
    return json({ success: true });
  }

  // Handle item order update
  if (result.data.organizationId && result.data.listId && result.data.itemOrder) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.data.itemOrder);
    } catch {
      parsed = [];
    }
    const orderResult = z.array(z.string()).safeParse(parsed);
    if (orderResult.success) {
      await updateItemOrder({
        user,
        organizationId: result.data.organizationId,
        listId: result.data.listId,
        order: orderResult.data,
      });
    }
    return json({ success: true });
  }

  // Build sectionCollapsed parameter if both sectionId and sectionCollapsed are provided
  const sectionCollapsed =
    result.data.sectionId !== undefined && result.data.sectionCollapsed !== undefined
      ? {
          sectionId: result.data.sectionId as SideMenuSectionId,
          collapsed: result.data.sectionCollapsed,
        }
      : undefined;

  await updateSideMenuPreferences({
    user,
    isCollapsed: result.data.isCollapsed,
    width: result.data.width,
    sectionCollapsed,
  });

  return json({ success: true });
}
