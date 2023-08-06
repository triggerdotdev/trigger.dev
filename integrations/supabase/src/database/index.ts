import { SupabaseClient, SupabaseClientOptions, createClient } from "@supabase/supabase-js";
import { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { GenericSchema } from "./types";

const tasks = {};

export type SupabaseIntegrationOptions<TSchema extends string> =
  | {
      /** The unique ID for this integration */
      id: string;
      /** The Supabase project url (e.g. "https://<project-id>.supabase.co") */
      supabaseUrl: string;
      /** The Supabase service account API Key (found in your Supabase Project Settings -> API -> service_role) */
      supabaseKey: string;
      /** Options that are passed through to the call the createClient */
      options?: SupabaseClientOptions<TSchema>;
    }
  | {
      id: string;
      projectId: string;
      supabaseKey: string;
      options?: SupabaseClientOptions<TSchema>;
    };

/**
 * A Trigger Integration for Supabase
 *
 * @example
 * ```ts
 * import { Supabase } from "@trigger.dev/supabase";
 * import { Database } from "@/supabase.types";
 *
 * const supabase = new Supabase<Database>({
 *  id: "my-supabase",
 *  projectId: process.env.SUPABASE_ID!,
 *  supabaseKey: process.env.SUPABASE_API_KEY!,
 * });
 * ```
 */
export class Supabase<
  Database = any,
  SchemaName extends string & keyof Database = "public" extends keyof Database
    ? "public"
    : string & keyof Database,
  Schema extends GenericSchema = Database[SchemaName] extends GenericSchema
    ? Database[SchemaName]
    : any,
> implements
    TriggerIntegration<
      IntegrationClient<SupabaseClient<Database, SchemaName, Schema>, typeof tasks>
    >
{
  client: IntegrationClient<SupabaseClient<Database, SchemaName, Schema>, typeof tasks>;

  /**
   * The native Supabase client. This is exposed for use outside of Trigger.dev jobs
   *
   * @example
   * ```ts
   * import { Supabase } from "@trigger.dev/supabase";
   * import { Database } from "@/supabase.types";
   *
   * const supabase = new Supabase<Database>({
   *   id: "my-supabase",
   *   projectId: process.env.SUPABASE_ID!,
   *   supabaseKey: process.env.SUPABASE_API_KEY!,
   * });
   *
   * const { data, error } = await supabase.native.from("users").select("*");
   * ```
   */
  public readonly native: SupabaseClient<Database, SchemaName, Schema>;

  constructor(private options: SupabaseIntegrationOptions<SchemaName>) {
    const supabaseOptions = options.options || {};

    const supabaseUrl =
      "projectId" in options ? `https://${options.projectId}.supabase.co` : options.supabaseUrl;

    this.native = createClient(supabaseUrl, options.supabaseKey, {
      ...supabaseOptions,
      auth: {
        ...supabaseOptions.auth,
        persistSession: false,
      },
    });

    this.client = {
      tasks,
      usesLocalAuth: true,
      client: this.native,
      auth: {
        supabaseUrl,
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
