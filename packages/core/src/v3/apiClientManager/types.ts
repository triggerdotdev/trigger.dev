import { ApiRequestOptions } from "../apiClient";

export type ApiClientConfiguration = {
  baseURL?: string;
  secretKey?: string;
  requestOptions?: ApiRequestOptions;
};
