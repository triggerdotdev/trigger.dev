import {
  EventFilter,
  EventSpecification,
  ExternalSource,
  ExternalSourceTrigger,
  HandlerEvent,
  IntegrationClient,
  Logger,
  TriggerIntegration,
  isTriggerError,
} from "@trigger.dev/sdk";
import { SupabaseManagementAPI } from "supabase-management-js";
import { z } from "zod";
import { Prettify, safeParseBody } from "@trigger.dev/integration-kit";
import * as tasks from "./tasks";
import { randomUUID } from "crypto";
import { GenericSchema } from "../database/types";

export type SupabaseManagementIntegrationOptions =
  | {
      id: string;
    }
  | {
      id: string;
      apiKey: string;
    };

type SupabaseManagementIntegrationClient = IntegrationClient<SupabaseManagementAPI, typeof tasks>;
type SupabaseManagementIntegration = TriggerIntegration<SupabaseManagementIntegrationClient>;

class SupabaseDatabase<Database = any> {
  constructor(
    private integration: SupabaseManagement,
    private projectRef: string
  ) {}

  /**
   * The function `on` creates a trigger for when a record is inserted, updated, or deleted on a
   * specific table in a database schema.
   * @param params - The `params` parameter is an object that contains the following properties:
   * @param params.table - The `table` property is a string that specifies the name of the table
   * that the trigger will be created for.
   * @param params.events - The `events` property is an array of events that specifies the events
   * that the trigger will be called for. The events that can be specified are `INSERT`, `UPDATE`, or `DELETE`.
   * By default, the trigger will be called for all events.
   * @param params.schema - The `schema` property is a string that specifies the name of the schema
   * that the trigger will be created for. If the schema is not specified, the default schema will
   * be used. (public)
   * @param params.filter - The `filter` property is an object that specifies the filter that will
   * be used to determine if the trigger should be called. If the filter is not specified, the
   * trigger will be called for all records.
   *
   * @example
   *
   * ```ts
   * const supabase = new SupabaseManagement({ id: "supabase" });
   * const database = supabase.database<Database>("https://<project-id>.supabase.co");
   *
   * client.defineJob({
   *  trigger: database.on({
   *    table: "todos",
   *    events: ["INSERTED", "UPDATED"],
   *    schema: "public",
   *    filter: {
   *     record: { is_completed: [false] },
   *    },
   *  }),
   * })
   * ```
   */
  on<
    SchemaName extends string & keyof Database = "public" extends keyof Database
      ? "public"
      : string & keyof Database,
    Schema extends GenericSchema = Database[SchemaName] extends GenericSchema
      ? Database[SchemaName]
      : any,
    TTableName extends string & keyof Schema["Tables"] = string & keyof Schema["Tables"],
    TTable extends Schema["Tables"][TTableName] = Schema["Tables"][TTableName],
    TEvents extends WebhookEvents[] = ["INSERT", "UPDATE", "DELETE"],
  >(params: { table: TTableName; events?: TEvents; schema?: SchemaName; filter?: EventFilter }) {
    return createTrigger<Prettify<UnionPayloads<TEvents, TTableName, SchemaName, TTable["Row"]>>>(
      this.integration.source,
      {
        event: params.events ?? ["INSERT", "UPDATE", "DELETE"],
        projectRef: this.projectRef,
        ...params,
      }
    );
  }

  /**
   * The function `onInserted` creates a trigger for when a new record is inserted into a specific
   * table in a database schema.
   * @param params - The `params` parameter is an object that contains the following properties:
   * @param params.table - The `table` property is a string that specifies the name of the table
   * that the trigger will be created for.
   * @param params.schema - The `schema` property is a string that specifies the name of the schema
   * that the trigger will be created for. If the schema is not specified, the default schema will
   * be used. (public)
   * @param params.filter - The `filter` property is an object that specifies the filter that will
   * be used to determine if the trigger should be called. If the filter is not specified, the
   * trigger will be called for all records.
   *
   * @example
   *
   * ```ts
   * const supabase = new SupabaseManagement({ id: "supabase" });
   * const database = supabase.database<Database>("https://<project-id>.supabase.co");
   *
   * client.defineJob({
   *  trigger: database.onInserted({
   *    table: "todos",
   *    schema: "public",
   *    filter: {
   *     record: { is_completed: [false] },
   *    },
   *  }),
   * })
   * ```
   */
  onInserted<
    SchemaName extends string & keyof Database = "public" extends keyof Database
      ? "public"
      : string & keyof Database,
    Schema extends GenericSchema = Database[SchemaName] extends GenericSchema
      ? Database[SchemaName]
      : any,
    TTableName extends string & keyof Schema["Tables"] = string & keyof Schema["Tables"],
    TTable extends Schema["Tables"][TTableName] = Schema["Tables"][TTableName],
  >(params: { table: TTableName; schema?: SchemaName; filter?: EventFilter }) {
    return createTrigger<{
      table: TTableName;
      record: Prettify<TTable["Row"]>;
      type: "INSERT";
      schema: SchemaName;
      old_record: null;
    }>(this.integration.source, {
      event: "INSERT",
      projectRef: this.projectRef,
      ...params,
    });
  }

  /**
   * The function `onUpdated` creates a trigger for when a new record is updated on a specific
   * table in a database schema.
   * @param params - The `params` parameter is an object that contains the following properties:
   * @param params.table - The `table` property is a string that specifies the name of the table
   * that the trigger will be created for.
   * @param params.schema - The `schema` property is a string that specifies the name of the schema
   * that the trigger will be created for. If the schema is not specified, the default schema will
   * be used. (public)
   * @param params.filter - The `filter` property is an object that specifies the filter that will
   * be used to determine if the trigger should be called. If the filter is not specified, the
   * trigger will be called for all records.
   *
   * @example
   *
   * ```ts
   * const supabase = new SupabaseManagement({ id: "supabase" });
   * const database = supabase.database<Database>("https://<project-id>.supabase.co");
   *
   * client.defineJob({
   *  trigger: database.onUpdated({
   *    table: "todos",
   *    schema: "public",
   *    filter: {
   *     record: { completed: [true] },
   *     old_record: { completed: [false] },
   *    },
   *  }),
   * })
   * ```
   */
  onUpdated<
    SchemaName extends string & keyof Database = "public" extends keyof Database
      ? "public"
      : string & keyof Database,
    Schema extends GenericSchema = Database[SchemaName] extends GenericSchema
      ? Database[SchemaName]
      : any,
    TTableName extends string & keyof Schema["Tables"] = string & keyof Schema["Tables"],
    TTable extends Schema["Tables"][TTableName] = Schema["Tables"][TTableName],
  >(params: { table: TTableName; schema?: SchemaName; filter?: EventFilter }) {
    return createTrigger<{
      table: TTableName;
      record: Prettify<TTable["Row"]>;
      type: "UPDATE";
      schema: SchemaName;
      old_record: Prettify<TTable["Row"]>;
    }>(this.integration.source, {
      event: "UPDATE",
      projectRef: this.projectRef,
      ...params,
    });
  }

  /**
   * The function `onDeleted` creates a trigger for when a new record is deleted from a specific
   * table in a database schema.
   * @param params - The `params` parameter is an object that contains the following properties:
   * @param params.table - The `table` property is a string that specifies the name of the table
   * that the trigger will be created for.
   * @param params.schema - The `schema` property is a string that specifies the name of the schema
   * that the trigger will be created for. If the schema is not specified, the default schema will
   * be used. (public)
   * @param params.filter - The `filter` property is an object that specifies the filter that will
   * be used to determine if the trigger should be called. If the filter is not specified, the
   * trigger will be called for all records.
   *
   * @example
   *
   * ```ts
   * const supabase = new SupabaseManagement({ id: "supabase" });
   * const database = supabase.database<Database>("https://<project-id>.supabase.co");
   *
   * client.defineJob({
   *  trigger: database.onDeleted({
   *    table: "todos",
   *    schema: "public",
   *    filter: {
   *     old_record: { is_completed: [true] },
   *    },
   *  }),
   * })
   * ```
   */
  onDeleted<
    SchemaName extends string & keyof Database = "public" extends keyof Database
      ? "public"
      : string & keyof Database,
    Schema extends GenericSchema = Database[SchemaName] extends GenericSchema
      ? Database[SchemaName]
      : any,
    TTableName extends string & keyof Schema["Tables"] = string & keyof Schema["Tables"],
    TTable extends Schema["Tables"][TTableName] = Schema["Tables"][TTableName],
  >(params: { table: TTableName; schema?: SchemaName; filter?: EventFilter }) {
    return createTrigger<{
      table: TTableName;
      record: null;
      type: "DELETE";
      schema: SchemaName;
      old_record: Prettify<TTable["Row"]>;
    }>(this.integration.source, {
      event: "DELETE",
      projectRef: this.projectRef,
      ...params,
    });
  }
}

export class SupabaseManagement implements SupabaseManagementIntegration {
  client: SupabaseManagementIntegrationClient;

  constructor(private options: SupabaseManagementIntegrationOptions) {
    if ("apiKey" in options) {
      if (!options.apiKey || options.apiKey === "") {
        throw `Can't create SupabaseManagement integration (${options.id}) as apiKey is undefined`;
      }

      this.client = {
        tasks,
        usesLocalAuth: true,
        client: new SupabaseManagementAPI({ accessToken: options.apiKey }),
        auth: {
          apiKey: options.apiKey,
        },
      };
    } else {
      this.client = {
        tasks,
        usesLocalAuth: false,
        clientFactory: (auth) => {
          return new SupabaseManagementAPI({ accessToken: auth.accessToken });
        },
      };
    }
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "supabase-management", name: "Supabase Management API" };
  }

  get source(): WebhookEventSource {
    return createWebhookEventSource(this);
  }

  /**
   * Creates a new database instance that can be used to listen to changes in the database.
   *
   * @param projectIdOrUrl The project ID or URL of the Supabase project (e.g. `https://<project-id>.supabase.co`)
   * @param options Options for the database instance
   */
  db<Database = any>(projectIdOrUrl: string) {
    const projectRef = getProjectRef(projectIdOrUrl);

    return new SupabaseDatabase<Database>(this, projectRef);
  }
}

/**
 *
 * @param projectIdOrUrl The project ID or URL of the Supabase project (e.g. `https://<project-id>.supabase.co`)
 * @returns The project reference of the Supabase project (e.g. `<project-id>`)
 */
function getProjectRef(projectIdOrUrl: string) {
  if (projectIdOrUrl.startsWith("http")) {
    const url = new URL(projectIdOrUrl);
    return url.hostname.split(".")[0];
  }

  return projectIdOrUrl;
}

type WebhookEventSource = ReturnType<typeof createWebhookEventSource>;

type WebhookEvents = "INSERT" | "UPDATE" | "DELETE";

type WebhookEventPayloads<
  TTableName extends string,
  TSchemaName extends string = "public",
  TRecord = any,
> = {
  INSERT: {
    table: TTableName;
    record: Prettify<TRecord>;
    type: "INSERT";
    schema: TSchemaName;
    old_record: null;
  };
  UPDATE: {
    table: TTableName;
    record: Prettify<TRecord>;
    type: "UPDATE";
    schema: TSchemaName;
    old_record: Prettify<TRecord>;
  };
  DELETE: {
    table: TTableName;
    record: null;
    type: "DELETE";
    schema: TSchemaName;
    old_record: Prettify<TRecord>;
  };
};

type UnionPayloads<
  T extends WebhookEvents[],
  TTableName extends string,
  TSchemaName extends string = "public",
  TRecord = any,
> = WebhookEventPayloads<TTableName, TSchemaName, TRecord>[T[number]];

function createTrigger<TEvent extends any>(
  source: WebhookEventSource,
  params: { event: WebhookEvents | WebhookEvents[]; filter?: EventFilter } & {
    projectRef: string;
    table: string;
    schema?: string;
  }
): ExternalSourceTrigger<EventSpecification<TEvent>, WebhookEventSource> {
  const eventSpecification = {
    name: params.event,
    title: "Supabase DB Webhook",
    source: "supabase",
    icon: "supabase",
    filter: {
      ...params.filter,
      type: typeof params.event === "string" ? [params.event] : params.event,
      schema: [params.schema ?? "public"],
    },
    properties: [],
    parsePayload: (payload: any) => payload as TEvent,
  };

  return new ExternalSourceTrigger({
    event: eventSpecification,
    params: {
      projectRef: params.projectRef,
      table: params.table,
      schema: params.schema ?? "public",
    },
    source,
  });
}

const WebhookSchema = z.object({
  projectRef: z.string(),
  table: z.string(),
  schema: z.string(),
});

const WebhookData = z.object({
  triggerName: z.string(),
  table: z.string(),
  schema: z.string(),
});

export function createWebhookEventSource(
  integration: SupabaseManagementIntegration
): ExternalSource<
  SupabaseManagementIntegration,
  {
    projectRef: string;
    table: string;
    schema: string;
  },
  "HTTP"
> {
  return new ExternalSource("HTTP", {
    id: "supabase.webhook",
    schema: WebhookSchema,
    version: "0.1.1",
    integration,
    filter: (params) => {
      return {
        table: [params.table],
      };
    },
    key: (params) => `${params.projectRef}-${params.schema}-${params.table}`,
    properties: (params) => [
      {
        label: "Project Ref",
        text: params.projectRef,
      },
      {
        label: "Table",
        text: `${params.schema}.${params.table}`,
      },
    ],
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, events, missingEvents } = event;

      const webhookData = WebhookData.safeParse(httpSource.data);

      if (httpSource.active && webhookData.success) {
        const { triggerName, table, schema } = webhookData.data;

        const allEvents = new Set<string>([...events, ...missingEvents]) as Set<WebhookEvents>;

        const condition = createTriggerCondition(Array.from(allEvents));

        const query = createTriggerQuery({
          triggerName,
          condition,
          schema: params.schema,
          table: params.table,
          url: httpSource.url,
          secret: httpSource.secret,
        });

        const queryResults = await io.integration.runQuery("update-trigger", {
          ref: params.projectRef,
          query,
        });

        await io.logger.debug("Query results", { queryResults });

        return {
          data: {
            triggerName: triggerName,
            table: table,
            schema: schema,
          },
          registeredEvents: Array.from(allEvents),
        };
      }

      const url = new URL(httpSource.url);
      const id = url.pathname.split("/").pop() ?? randomUUID();

      try {
        await io.integration.enableDatabaseWebhooks("enable-webhooks", { ref: params.projectRef });
      } catch (error) {
        if (isTriggerError(error)) {
          throw error;
        }

        await io.logger.info(
          "Enabling database webhooks failed, probably because it is already enabled. Continuing...",
          { error }
        );
      }

      // Create the trigger name using the last 12 characters of the id
      const triggerName = `tr_${id.slice(-12)}`;

      const condition = createTriggerCondition(events as WebhookEvents[]);

      const query = createTriggerQuery({
        triggerName,
        condition,
        schema: params.schema,
        table: params.table,
        url: httpSource.url,
        secret: httpSource.secret,
      });

      const queryResults = await io.integration.runQuery("create-trigger", {
        ref: params.projectRef,
        query,
      });

      await io.logger.debug("Query results", { queryResults });

      return {
        data: {
          triggerName: triggerName,
          table: params.table,
          schema: params.schema,
        },
        registeredEvents: events,
      };
    },
  });
}

function createTriggerQuery({
  triggerName,
  condition,
  schema,
  table,
  url,
  secret,
}: {
  triggerName: string;
  condition: string;
  schema: string;
  table: string;
  url: string;
  secret: string;
}): string {
  return `
    CREATE OR REPLACE TRIGGER ${triggerName}
    AFTER ${condition} on "${schema}"."${table}"
    FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('${url}', 'POST', '{"Content-type":"application/json", "Authorization": "Bearer ${secret}" }', '{}', '1000')
  `;
}

function createTriggerCondition(events: WebhookEvents[]): string {
  return events.join(" OR ");
}

async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger) {
  logger.debug("[inside supabase management integration] Handling webhook handler");

  const { rawEvent: request, source } = event;

  if (!request.body) {
    logger.debug("[inside supabase management integration] No body found");

    return;
  }

  // Check the Bearer token matches the secret
  const authHeader = request.headers.get("Authorization");

  if (!authHeader) {
    logger.debug("[inside supabase management integration] No Authorization header found");

    return { events: [] };
  }

  const authHeaderParts = authHeader.split(" ");

  if (authHeaderParts.length !== 2) {
    logger.debug(
      "[inside supabase management integration] Authorization header is not in the correct format"
    );

    return { events: [] };
  }

  const token = authHeaderParts[1];

  if (token !== source.secret) {
    logger.debug(
      "[inside supabase management integration] Authorization header does not match the secret"
    );

    return { events: [] };
  }

  const rawBody = await request.text();

  const payload = safeParseBody(rawBody);

  if (!payload) {
    return { events: [] };
  }

  // Generate a unique ID for the event
  const id = randomUUID();

  return {
    events: [
      {
        id,
        name: payload.type,
        source: "supabase",
        payload,
        context: {},
      },
    ],
  };
}
