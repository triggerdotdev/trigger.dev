import { paths } from "./api/v1";
import createClient from "openapi-fetch";
import fetch from "node-fetch";
import { ExtractResponseContent } from "./api/utils";

export type SupabaseManagementAPIOptions = {
  accessToken: string;
  baseUrl?: string;
};

export type RunQueryResponseData = ExtractResponseContent<
  paths["/v1/projects/{ref}/query"],
  "post",
  201
>;

export type GetProjectsResponseData = ExtractResponseContent<
  paths["/v1/projects"],
  "get",
  200
>;

export class SupabaseManagementAPIError extends Error {
  constructor(message: string, public readonly response: Response) {
    super(message);
  }
}

export class SupabaseManagementAPI {
  constructor(private readonly options: SupabaseManagementAPIOptions) {}

  async getProjects(): Promise<GetProjectsResponseData> {
    const { data, response } = await this.client.get("/v1/projects", {});

    if (response.status !== 200) {
      throw new SupabaseManagementAPIError(
        `Failed to get projects: ${response.statusText} (${response.status})`,
        response
      );
    }

    return data;
  }

  async queryProject(
    ref: string,
    query: string
  ): Promise<RunQueryResponseData> {
    const { data, response } = await this.client.post(
      "/v1/projects/{ref}/query",
      {
        params: {
          path: {
            ref,
          },
        },
        body: {
          query,
        },
      }
    );

    if (response.status !== 201) {
      throw new SupabaseManagementAPIError(
        `Failed to run query: ${response.statusText} (${response.status})`,
        response
      );
    }

    return data;
  }

  get client() {
    return createClient<paths>({
      baseUrl: this.options.baseUrl || "https://api.supabase.com/v1",
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
      },
      // @ts-ignore
      fetch,
    });
  }
}
