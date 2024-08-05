import { type ApiRequestOptions } from "../apiClient/index.js";

export type ApiClientConfiguration = {
  baseURL?: string;
  secretKey?: string;
  requestOptions?: ApiRequestOptions;
};
