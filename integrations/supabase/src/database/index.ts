import {
  SupabaseClient,
  SupabaseClientOptions,
  createClient,
} from "@supabase/supabase-js";
import { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { GenericSchema } from "./types";

const tasks = {};

export type SupabaseIntegrationOptions<TSchema extends string> = {
  id: string;
  supabaseUrl: string;
  supabaseKey: string;
  options?: SupabaseClientOptions<TSchema>;
};

export class Supabase<
  Database = any,
  SchemaName extends string & keyof Database = "public" extends keyof Database
    ? "public"
    : string & keyof Database,
  Schema extends GenericSchema = Database[SchemaName] extends GenericSchema
    ? Database[SchemaName]
    : any
> implements
    TriggerIntegration<
      IntegrationClient<
        SupabaseClient<Database, SchemaName, Schema>,
        typeof tasks
      >
    >
{
  client: IntegrationClient<
    SupabaseClient<Database, SchemaName, Schema>,
    typeof tasks
  >;

  constructor(private options: SupabaseIntegrationOptions<SchemaName>) {
    const supabaseOptions = options.options || {};

    const supabaseClient = createClient(
      options.supabaseUrl,
      options.supabaseKey,
      {
        ...supabaseOptions,
        auth: {
          ...supabaseOptions.auth,
          persistSession: false,
        },
      }
    );

    this.client = {
      tasks,
      usesLocalAuth: true,
      client: supabaseClient,
      auth: {
        supabaseUrl: options.supabaseUrl,
        supabaseKey: options.supabaseKey,
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "supabase", name: "Supabase" };
  }
}
