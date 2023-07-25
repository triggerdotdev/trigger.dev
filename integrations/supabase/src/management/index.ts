import {
  EventSpecification,
  ExternalSource,
  ExternalSourceTrigger,
  HandlerEvent,
  IntegrationClient,
  Logger,
  TriggerIntegration,
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

type SupabaseManagementIntegrationClient = IntegrationClient<
  SupabaseManagementAPI,
  typeof tasks
>;
type SupabaseManagementIntegration =
  TriggerIntegration<SupabaseManagementIntegrationClient>;

class SupabaseDatabase<
  Database = any,
  SchemaName extends string & keyof Database = "public" extends keyof Database
    ? "public"
    : string & keyof Database,
  Schema extends GenericSchema = Database[SchemaName] extends GenericSchema
    ? Database[SchemaName]
    : any
> {
  constructor(
    private integration: SupabaseManagement,
    private projectRef: string,
    private schema: SchemaName = "public" as SchemaName
  ) {}

  onChange<
    TableName extends string & keyof Schema["Tables"],
    Table extends Schema["Tables"][TableName]
  >(table: TableName): Table["Row"] {
    return {} as Table["Row"];
  }

  onInserted<
    TTableName extends string & keyof Schema["Tables"],
    TTable extends Schema["Tables"][TTableName]
  >(params: { table: TTableName }) {
    return createTrigger<{
      table: TTableName;
      record: Prettify<TTable["Row"]>;
      type: "INSERT";
      schema: SchemaName;
      old_record: null;
    }>(this.integration.source, {
      event: "insert",
      projectRef: this.projectRef,
      ...params,
    });
  }

  onUpdated<
    TTableName extends string & keyof Schema["Tables"],
    TTable extends Schema["Tables"][TTableName],
    TColumns extends Array<string & keyof TTable["Row"]>
  >(params: { table: TTableName; columns?: TColumns }) {
    return createTrigger<{
      table: TTableName;
      record: Prettify<TTable["Row"]>;
      type: "UPDATE";
      schema: SchemaName;
      old_record: Prettify<TTable["Row"]>;
    }>(this.integration.source, {
      event: "update",
      projectRef: this.projectRef,
      columns: params.columns,
      ...params,
    });
  }

  onDeleted<
    TTableName extends string & keyof Schema["Tables"],
    TTable extends Schema["Tables"][TTableName]
  >(params: { table: TTableName }) {
    return createTrigger<{
      table: TTableName;
      record: null;
      type: "DELETE";
      schema: SchemaName;
      old_record: Prettify<TTable["Row"]>;
    }>(this.integration.source, {
      event: "delete",
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

  db<
    Database = any,
    SchemaName extends string & keyof Database = "public" extends keyof Database
      ? "public"
      : string & keyof Database,
    Schema extends GenericSchema = Database[SchemaName] extends GenericSchema
      ? Database[SchemaName]
      : any
  >(projectRef: string, options?: { schema?: SchemaName }) {
    return new SupabaseDatabase<Database, SchemaName, Schema>(
      this,
      projectRef,
      options?.schema
    );
  }
}

type WebhookEventSource = ReturnType<typeof createWebhookEventSource>;

type WebhookEvents = "insert" | "update" | "delete";

function createTrigger<TEvent extends any>(
  source: WebhookEventSource,
  params: { event: WebhookEvents } & {
    projectRef: string;
    table: string;
    columns?: string[];
  }
): ExternalSourceTrigger<EventSpecification<TEvent>, WebhookEventSource> {
  const eventSpecification = {
    name: params.event,
    title: `Supabase ${params.event}`,
    source: "supabase",
    icon: "supabase",
    properties: [
      {
        label: "Project Ref",
        text: params.projectRef,
      },
      {
        label: "Table",
        text: params.table,
      },
      ...(params.columns
        ? [
            {
              label: "Columns",
              text: params.columns.join(", "),
            },
          ]
        : []),
    ],
    parsePayload: (payload: any) => payload as TEvent,
  };

  return new ExternalSourceTrigger({
    event: eventSpecification,
    params: {
      projectRef: params.projectRef,
      table: params.table,
      columns: params.columns,
    },
    source,
  });
}

const WebhookSchema = z.object({
  projectRef: z.string(),
  table: z.string(),
  schema: z.string().optional(),
  columns: z.array(z.string()).optional(),
});

const WebhookData = z.object({
  triggerName: z.string(),
  table: z.string(),
  schema: z.string().optional(),
  columns: z.array(z.string()).optional(),
});

export function createWebhookEventSource(
  integration: SupabaseManagementIntegration
): ExternalSource<
  SupabaseManagementIntegration,
  { projectRef: string; table: string; schema?: string; columns?: string[] },
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
    key: (params) =>
      `${params.projectRef}-${params.schema ?? "public"}-${params.table}${
        params.columns ? `-${params.columns.sort().join("-")}` : ""
      }`,
    properties: (params) => [
      {
        label: "Project Ref",
        text: params.projectRef,
      },
      {
        label: "Table",
        text: params.table,
      },
    ],
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, events, missingEvents } = event;

      const webhookData = WebhookData.safeParse(httpSource.data);

      if (httpSource.active && webhookData.success) {
        const { triggerName, table, schema, columns } = webhookData.data;

        const allEvents = new Set<string>([
          ...events,
          ...missingEvents,
        ]) as Set<WebhookEvents>;

        const allColumns = new Set<string>([
          ...(columns ?? []),
          ...(params.columns ?? []),
        ]) as Set<string>;

        const condition = createTriggerCondition(
          Array.from(allEvents),
          Array.from(allColumns)
        );

        const query = createTriggerQuery({
          triggerName,
          condition,
          schema: params.schema ?? "public",
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
            columns: Array.from(allColumns),
          },
          registeredEvents: Array.from(allEvents),
        };
      }

      const url = new URL(httpSource.url);
      const id = url.pathname.split("/").pop();

      const triggerName = `trigger_${id}`;

      const condition = createTriggerCondition(
        events as WebhookEvents[],
        params.columns
      );

      const query = createTriggerQuery({
        triggerName,
        condition,
        schema: params.schema ?? "public",
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
          columns: params.columns ?? [],
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

function createTriggerCondition(
  events: WebhookEvents[],
  columns?: string[]
): string {
  return events
    .map((event) => {
      switch (event) {
        case "insert":
          return `INSERT`;
        case "update":
          return `UPDATE ${
            columns ? `OF ${columns.map((c) => `${c}`).join(", ")}` : ""
          }`;
        case "delete":
          return `DELETE`;
      }
    })
    .join(" OR ");
}

async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger) {
  logger.debug(
    "[inside supabase management integration] Handling webhook handler"
  );

  const { rawEvent: request, source } = event;

  if (!request.body) {
    logger.debug("[inside supabase management integration] No body found");

    return;
  }

  // Check the Bearer token matches the secret
  const authHeader = request.headers.get("Authorization");

  if (!authHeader) {
    logger.debug(
      "[inside supabase management integration] No Authorization header found"
    );

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
        name: payload.type.toLowerCase(),
        source: "supabase",
        payload,
        context: {},
      },
    ],
  };
}
