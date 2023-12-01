import {
  ConnectionAuth,
  EventFilter,
  EventSpecification,
  ExternalSource,
  ExternalSourceTrigger,
  HandlerEvent,
  IO,
  IOTask,
  IntegrationTaskKey,
  Json,
  Logger,
  RunTaskErrorCallback,
  RunTaskOptions,
  TriggerIntegration,
  isTriggerError,
  retry,
  OverridableRunTaskOptions,
} from "@trigger.dev/sdk";
import {
  CreateProjectRequestBody,
  CreateProjectResponseData,
  GetOrganizationsResponseData,
  GetPostgRESTConfigResponseData,
  GetProjectPGConfigResponseData,
  GetProjectsResponseData,
  GetTypescriptTypesResponseData,
  ListFunctionsResponseData,
  RunQueryResponseData,
  SupabaseManagementAPI,
} from "supabase-management-js";
import { z } from "zod";
import { Prettify, safeParseBody } from "@trigger.dev/integration-kit";
import { randomUUID } from "node:crypto";
import { GenericSchema } from "../database/types";

export type SupabaseManagementIntegrationOptions =
  | {
      id: string;
    }
  | {
      id: string;
      apiKey: string;
    };

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

export class SupabaseManagement implements TriggerIntegration {
  // @internal
  private _options: SupabaseManagementIntegrationOptions;
  // @internal
  private _client?: SupabaseManagementAPI;
  // @internal
  private _io?: IO;
  // @internal
  private _connectionKey?: string;

  constructor(private options: SupabaseManagementIntegrationOptions) {
    this._options = options;

    if ("apiKey" in options) {
      if (!options.apiKey || options.apiKey === "") {
        throw `Can't create SupabaseManagement integration (${options.id}) as apiKey is undefined`;
      }
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

  get authSource() {
    if ("apiKey" in this._options) {
      return "LOCAL";
    }

    return "HOSTED" as const;
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const supabase = new SupabaseManagement(this._options);
    supabase._io = io;
    supabase._connectionKey = connectionKey;

    if ("apiKey" in this._options) {
      if (!this._options.apiKey || this._options.apiKey === "") {
        throw `Can't create SupabaseManagement integration (${this._options.id}) as apiKey is undefined`;
      }
      supabase._client = new SupabaseManagementAPI({ accessToken: this._options.apiKey });
    } else if (auth) {
      supabase._client = new SupabaseManagementAPI({ accessToken: auth.accessToken });
    } else {
      throw `Can't create SupabaseManagement integration (${this._options.id}) as auth is undefined`;
    }

    return supabase;
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: SupabaseManagementAPI, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ): Promise<TResult> {
    if (!this._io) throw new Error("No IO");
    if (!this._connectionKey) throw new Error("No connection key");
    return this._io.runTask(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        return callback(this._client, task, io);
      },
      {
        icon: "supabase",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback
    );
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

  getOrganizations(key: IntegrationTaskKey): Promise<GetOrganizationsResponseData> {
    return this.runTask(
      key,
      (client) => {
        return client.getOrganizations();
      },
      {
        name: "Get Organizations",
      }
    );
  }

  getProjects(key: IntegrationTaskKey): Promise<GetProjectsResponseData> {
    return this.runTask(
      key,
      (client) => {
        return client.getProjects();
      },
      {
        name: "Get Projects",
      }
    );
  }

  createProject(
    key: IntegrationTaskKey,
    params: CreateProjectRequestBody
  ): Promise<CreateProjectResponseData> {
    return this.runTask(
      key,
      (client) => {
        return client.createProject(params);
      },
      {
        name: "Create Project",
        params,
        properties: [
          { label: "Name", text: params.name },
          { label: "Org", text: params.organization_id },
          { label: "Region", text: params.region },
          { label: "Plan", text: params.plan },
        ],
      }
    );
  }

  listFunctions(
    key: IntegrationTaskKey,
    params: { ref: string }
  ): Promise<ListFunctionsResponseData> {
    return this.runTask(
      key,
      (client) => {
        return client.listFunctions(params.ref);
      },
      {
        name: "List Functions",
        params,
        properties: [
          {
            label: "Project",
            text: params.ref,
          },
        ],
      }
    );
  }

  runQuery(
    key: IntegrationTaskKey,
    params: { ref: string; query: string }
  ): Promise<RunQueryResponseData> {
    return this.runTask(
      key,
      (client) => {
        return client.runQuery(params.ref, params.query);
      },
      {
        name: "Run Query",
        params,
        properties: [
          {
            label: "Project",
            text: params.ref,
          },
        ],
      }
    );
  }

  getTypescriptTypes(
    key: IntegrationTaskKey,
    params: { ref: string }
  ): Promise<GetTypescriptTypesResponseData> {
    return this.runTask(
      key,
      (client) => {
        return client.getTypescriptTypes(params.ref);
      },
      {
        name: "Get Typescript Types",
        params,
        properties: [
          {
            label: "Project",
            text: params.ref,
          },
        ],
      }
    );
  }

  getPostgRESTConfig(
    key: IntegrationTaskKey,
    params: { ref: string }
  ): Promise<GetPostgRESTConfigResponseData> {
    return this.runTask(
      key,
      (client) => {
        return client.getPostgRESTConfig(params.ref);
      },
      {
        name: "Get PostgREST Config",
        params,
        properties: [
          {
            label: "Project",
            text: params.ref,
          },
        ],
      }
    );
  }

  /** Gets project's Postgres config */
  getPGConfig(
    key: IntegrationTaskKey,
    params: { ref: string }
  ): Promise<GetProjectPGConfigResponseData> {
    return this.runTask(
      key,
      (client) => {
        return client.getPGConfig(params.ref);
      },
      {
        name: "Get PG Config",
        params,
        properties: [
          {
            label: "Project",
            text: params.ref,
          },
        ],
      }
    );
  }

  /** Enable Database Webhooks in project */
  enableDatabaseWebhooks(
    key: IntegrationTaskKey,
    params: { ref: string },
    options: OverridableRunTaskOptions = {}
  ): Promise<void> {
    return this.runTask(
      key,
      (client) => {
        return client.enableWebhooks(params.ref);
      },
      {
        name: "Enable Database Webhooks",
        params,
        properties: [
          {
            label: "Project",
            text: params.ref,
          },
        ],
        ...options,
      }
    );
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
    options: {},
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

export function createWebhookEventSource(integration: SupabaseManagement): ExternalSource<
  SupabaseManagement,
  {
    projectRef: string;
    table: string;
    schema: string;
  },
  "HTTP",
  {}
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
      const { params, source: httpSource, options } = event;

      const webhookData = WebhookData.safeParse(httpSource.data);

      if (httpSource.active && webhookData.success) {
        const { triggerName, table, schema } = webhookData.data;

        const allEvents = new Set<string>([
          ...options.event.desired,
          ...options.event.missing,
        ]) as Set<WebhookEvents>;

        const registeredOptions = {
          event: [...allEvents],
        };

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
          options: registeredOptions,
        };
      }

      const url = new URL(httpSource.url);
      const id = url.pathname.split("/").pop() ?? randomUUID();

      try {
        await io.integration.enableDatabaseWebhooks(
          "enable-webhooks",
          { ref: params.projectRef },
          {
            retry: undefined,
          }
        );
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

      const condition = createTriggerCondition(options.event.desired as WebhookEvents[]);

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
        options: { event: options.event.desired },
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
