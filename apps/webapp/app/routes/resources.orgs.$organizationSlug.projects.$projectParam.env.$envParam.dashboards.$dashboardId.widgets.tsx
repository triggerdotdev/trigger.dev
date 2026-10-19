import { type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { typedjson } from "remix-typedjson";
import { QueryWidgetConfig } from "~/components/metrics/QueryWidget";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { LayoutItem } from "~/presenters/v3/MetricDashboardPresenter.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { MetricDashboardService } from "~/v3/services/metricDashboard.server";
import { tryCatch } from "@trigger.dev/core/utils";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

// Schemas for each action type
const AddWidgetSchema = z.object({
  widgetId: z.string().min(1, "Widget ID is required").nullish(),
  title: z.string().min(1, "Title is required"),
  query: z.string().default(""),
  config: z.string().transform((str, ctx) => {
    try {
      const parsed = JSON.parse(str);
      const result = QueryWidgetConfig.safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid widget config",
        });
        return z.NEVER;
      }
      return result.data;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid JSON",
      });
      return z.NEVER;
    }
  }),
});

const UpdateWidgetSchema = z.object({
  widgetId: z.string().min(1, "Widget ID is required"),
  title: z.string().min(1, "Title is required"),
  query: z.string().min(1, "Query is required"),
  config: z.string().transform((str, ctx) => {
    try {
      const parsed = JSON.parse(str);
      const result = QueryWidgetConfig.safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid widget config",
        });
        return z.NEVER;
      }
      return result.data;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid JSON",
      });
      return z.NEVER;
    }
  }),
});

const RenameWidgetSchema = z.object({
  widgetId: z.string().min(1, "Widget ID is required"),
  title: z.string().min(1, "Title is required"),
});

const DeleteWidgetSchema = z.object({
  widgetId: z.string().min(1, "Widget ID is required"),
});

const DuplicateWidgetSchema = z.object({
  widgetId: z.string().min(1, "Widget ID is required"),
  newId: z.string().min(1, "New widget ID is required").nullish(),
});

const SaveLayoutSchema = z.object({
  layout: z.string().transform((str, ctx) => {
    try {
      const parsed = JSON.parse(str);
      const result = z.array(LayoutItem).safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid layout format",
        });
        return z.NEVER;
      }
      return result.data;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid JSON",
      });
      return z.NEVER;
    }
  }),
});

const ParamsSchema = EnvironmentParamSchema.extend({
  dashboardId: z.string(),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, dashboardId } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const formData = await request.formData();
  const action = formData.get("action");
  const ref = { organizationId: project.organizationId, friendlyId: dashboardId };
  const service = new MetricDashboardService();

  const [error, response] = await tryCatch(
    (async () => {
      switch (action) {
        case "add": {
          const result = AddWidgetSchema.safeParse({
            widgetId: formData.get("widgetId"),
            title: formData.get("title"),
            query: formData.get("query"),
            config: formData.get("config"),
          });
          if (!result.success) {
            throw new Response("Invalid form data: " + result.error.message, { status: 400 });
          }

          const { widgetId } = await service.addWidget({
            ...ref,
            widget: {
              id: result.data.widgetId ?? undefined,
              title: result.data.title,
              query: result.data.query,
              display: result.data.config,
            },
          });

          return typedjson({ success: true, widgetId });
        }
        case "update": {
          const result = UpdateWidgetSchema.safeParse({
            widgetId: formData.get("widgetId"),
            title: formData.get("title"),
            query: formData.get("query"),
            config: formData.get("config"),
          });
          if (!result.success) {
            throw new Response("Invalid form data: " + result.error.message, { status: 400 });
          }

          const { widgetId, title, query, config } = result.data;
          await service.updateWidget({
            ...ref,
            widgetId,
            changes: { title, query, display: config },
          });

          return typedjson({ success: true, updatedTitle: title });
        }
        case "rename": {
          const result = RenameWidgetSchema.safeParse({
            widgetId: formData.get("widgetId"),
            title: formData.get("title"),
          });
          if (!result.success) {
            throw new Response("Invalid form data: " + result.error.message, { status: 400 });
          }

          const { widgetId, title } = result.data;
          await service.updateWidget({ ...ref, widgetId, changes: { title } });

          return typedjson({ success: true, renamedTitle: title });
        }
        case "delete": {
          const result = DeleteWidgetSchema.safeParse({ widgetId: formData.get("widgetId") });
          if (!result.success) {
            throw new Response("Invalid form data: " + result.error.message, { status: 400 });
          }

          const { deleted } = await service.deleteWidget({
            ...ref,
            widgetId: result.data.widgetId,
          });

          return typedjson({ success: true, deletedTitle: deleted?.title ?? "Widget" });
        }
        case "duplicate": {
          const result = DuplicateWidgetSchema.safeParse({
            widgetId: formData.get("widgetId"),
            newId: formData.get("newId"),
          });
          if (!result.success) {
            throw new Response("Invalid form data: " + result.error.message, { status: 400 });
          }

          const { original } = await service.duplicateWidget({
            ...ref,
            widgetId: result.data.widgetId,
            newWidgetId: result.data.newId,
          });

          return typedjson({ success: true, duplicatedTitle: original.title });
        }
        case "layout": {
          const result = SaveLayoutSchema.safeParse({ layout: formData.get("layout") });
          if (!result.success) {
            throw new Response("Invalid form data: " + result.error.message, { status: 400 });
          }

          await service.saveLayout({ ...ref, layout: result.data.layout });

          return typedjson({ success: true });
        }
        default: {
          throw new Response("Invalid action", { status: 400 });
        }
      }
    })()
  );

  if (error) {
    if (error instanceof ServiceValidationError) {
      throw new Response(error.message, { status: error.status ?? 400 });
    }
    throw error;
  }

  return response;
};
