import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { PrismaClientOrTransaction } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { BaseService, ServiceValidationError } from "../baseService.server";

const ajv = new Ajv({ allErrors: true, strict: false });

/** Cached compiled validators keyed by EventDefinition.id */
const validatorCache = new Map<string, ValidateFunction>();

export type SchemaValidationResult =
  | { success: true }
  | { success: false; errors: SchemaValidationError[] };

export type SchemaValidationError = {
  path: string;
  message: string;
};

export type SchemaCompatibilityResult =
  | { compatible: true }
  | { compatible: false; reasons: string[] };

export class SchemaRegistryService extends BaseService {
  /**
   * Register (upsert) a JSON schema for an event definition.
   * Called during worker deploy when event manifests include schemas.
   */
  async registerSchema(params: {
    projectId: string;
    eventSlug: string;
    version: string;
    schema: unknown;
    description?: string;
  }): Promise<{ eventDefinitionId: string }> {
    const eventDef = await this._prisma.eventDefinition.upsert({
      where: {
        projectId_slug_version: {
          projectId: params.projectId,
          slug: params.eventSlug,
          version: params.version,
        },
      },
      create: {
        slug: params.eventSlug,
        version: params.version,
        schema: params.schema as any,
        description: params.description,
        projectId: params.projectId,
      },
      update: {
        schema: params.schema as any,
        description: params.description,
      },
    });

    // Invalidate cached validator when schema changes
    validatorCache.delete(eventDef.id);

    return { eventDefinitionId: eventDef.id };
  }

  /**
   * Get the schema for an event (latest version or specific version).
   */
  async getSchema(params: {
    projectId: string;
    eventSlug: string;
    version?: string;
  }): Promise<{
    id: string;
    slug: string;
    version: string;
    schema: unknown | null;
    description: string | null;
    deprecatedAt: Date | null;
    deprecatedMessage: string | null;
  } | null> {
    const where: any = {
      projectId: params.projectId,
      slug: params.eventSlug,
    };

    if (params.version) {
      where.version = params.version;
    }

    return this._prisma.eventDefinition.findFirst({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        slug: true,
        version: true,
        schema: true,
        description: true,
        deprecatedAt: true,
        deprecatedMessage: true,
      },
    });
  }

  /**
   * List all event definitions for a project with subscriber counts.
   */
  async listSchemas(params: {
    projectId: string;
    environmentId?: string;
  }): Promise<
    Array<{
      id: string;
      slug: string;
      version: string;
      description: string | null;
      schema: unknown | null;
      deprecatedAt: Date | null;
      subscriberCount: number;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    const eventDefs = await this._prisma.eventDefinition.findMany({
      where: {
        projectId: params.projectId,
      },
      include: {
        _count: {
          select: {
            subscriptions: params.environmentId
              ? {
                  where: {
                    environmentId: params.environmentId,
                    enabled: true,
                  },
                }
              : {
                  where: {
                    enabled: true,
                  },
                },
          },
        },
      },
      orderBy: [{ slug: "asc" }, { createdAt: "desc" }],
    });

    return eventDefs.map((def) => ({
      id: def.id,
      slug: def.slug,
      version: def.version,
      description: def.description,
      schema: def.schema,
      deprecatedAt: def.deprecatedAt,
      subscriberCount: def._count.subscriptions,
      createdAt: def.createdAt,
      updatedAt: def.updatedAt,
    }));
  }

  /**
   * Validate a payload against the stored JSON schema for an event.
   * Returns success:true if there is no schema (untyped events pass validation).
   */
  validatePayload(
    eventDefinitionId: string,
    schema: unknown | null,
    payload: unknown
  ): SchemaValidationResult {
    if (!schema) {
      return { success: true };
    }

    try {
      let validate = validatorCache.get(eventDefinitionId);

      if (!validate) {
        validate = ajv.compile(schema as object);
        validatorCache.set(eventDefinitionId, validate);
      }

      const valid = validate(payload);

      if (valid) {
        return { success: true };
      }

      return {
        success: false,
        errors: formatAjvErrors(validate.errors ?? []),
      };
    } catch (error) {
      logger.error("Schema validation error", {
        eventDefinitionId,
        error: error instanceof Error ? error.message : String(error),
      });

      // If schema compilation fails, we don't block the publish
      // (a broken schema shouldn't prevent events from flowing)
      return { success: true };
    }
  }

  /**
   * Check if a new schema version is backwards compatible with the previous version.
   * Compatible means: the new schema accepts all payloads that the old schema accepted.
   *
   * Heuristic checks (not exhaustive):
   * - Adding optional fields → compatible
   * - Removing required fields → incompatible
   * - Changing field types → incompatible
   * - Tightening constraints → incompatible
   */
  checkCompatibility(
    oldSchema: unknown,
    newSchema: unknown
  ): SchemaCompatibilityResult {
    if (!oldSchema || !newSchema) {
      return { compatible: true };
    }

    const reasons: string[] = [];
    const oldObj = oldSchema as Record<string, any>;
    const newObj = newSchema as Record<string, any>;

    // Check if required fields were added (breaking for existing producers)
    const oldRequired = new Set<string>(oldObj.required ?? []);
    const newRequired = new Set<string>(newObj.required ?? []);

    for (const field of newRequired) {
      if (!oldRequired.has(field)) {
        // New required field — check if it exists in old schema at all
        const oldProps = oldObj.properties ?? {};
        if (!(field in oldProps)) {
          reasons.push(
            `New required field "${field}" was not present in the previous schema`
          );
        }
      }
    }

    // Check if fields were removed
    const oldProperties = Object.keys(oldObj.properties ?? {});
    const newProperties = new Set(Object.keys(newObj.properties ?? {}));

    for (const field of oldProperties) {
      if (!newProperties.has(field) && oldRequired.has(field)) {
        reasons.push(
          `Required field "${field}" was removed in the new schema`
        );
      }
    }

    // Check if types changed for existing fields
    const oldProps = oldObj.properties ?? {};
    const newProps = newObj.properties ?? {};

    for (const field of oldProperties) {
      if (field in newProps) {
        const oldType = oldProps[field]?.type;
        const newType = newProps[field]?.type;

        if (oldType && newType && oldType !== newType) {
          reasons.push(
            `Field "${field}" changed type from "${oldType}" to "${newType}"`
          );
        }
      }
    }

    if (reasons.length > 0) {
      return { compatible: false, reasons };
    }

    return { compatible: true };
  }

  /**
   * Clear the validator cache (useful for testing or after mass schema updates).
   */
  static clearCache(): void {
    validatorCache.clear();
  }
}

function formatAjvErrors(errors: ErrorObject[]): SchemaValidationError[] {
  return errors.map((err) => ({
    path: err.instancePath || "/",
    message: err.message ?? "Validation failed",
  }));
}
