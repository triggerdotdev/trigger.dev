import { SupabaseClient, SupabaseClientOptions, createClient } from "@supabase/supabase-js";
import {
  ConnectionAuth,
  IO,
  IOTask,
  IntegrationTaskKey,
  Json,
  RunTaskErrorCallback,
  RunTaskOptions,
  TriggerIntegration,
  retry,
} from "@trigger.dev/sdk";
import { GenericSchema } from "./types";

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
> implements TriggerIntegration
{
  // @internal
  private _options: SupabaseIntegrationOptions<SchemaName>;
  // @internal
  private _client?: SupabaseClient<Database, SchemaName, Schema>;
  // @internal
  private _io?: IO;
  // @internal
  private _connectionKey?: string;

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
    this._options = options;

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
  }

  get authSource() {
    return "LOCAL" as const;
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "supabase", name: "Supabase" };
  }

  get client() {
    if (!this._client) {
      throw new Error("Supabase client not initialized");
    }
    return this._client;
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const supabase = new Supabase<Database, SchemaName, Schema>(this._options);
    supabase._io = io;
    supabase._connectionKey = connectionKey;

    const supabaseOptions = this._options.options || {};
    const supabaseUrl =
      "projectId" in this._options
        ? `https://${this._options.projectId}.supabase.co`
        : this._options.supabaseUrl;

    supabase._client = createClient(supabaseUrl, this._options.supabaseKey, {
      ...supabaseOptions,
      auth: {
        ...supabaseOptions.auth,
        persistSession: false,
      },
    });
    return supabase;
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (
      client: SupabaseClient<Database, SchemaName, Schema>,
      task: IOTask,
      io: IO
    ) => Promise<TResult>,
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
}
