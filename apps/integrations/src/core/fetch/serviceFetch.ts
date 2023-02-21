import { addCredentialsToConfig } from "core/authentication/credentials";
import {
  AuthCredentials,
  IntegrationAuthentication,
} from "core/authentication/types";
import { HTTPMethod } from "core/endpoint/types";
import { FetchConfig, RequestResponse } from "core/request/types";
import {
  getFetch,
  normalizeHeaders,
  responseFromCaughtError,
  safeGetJson,
} from "./fetchUtilities";

export type ServiceFetchOptions = {
  url: string;
  method: HTTPMethod;
  headers?: Record<string, string>;
  body?: any;
  authentication: IntegrationAuthentication;
  credentials?: AuthCredentials;
};

export async function serviceFetch({
  url,
  method = "GET",
  headers,
  body,
  credentials,
  authentication,
}: ServiceFetchOptions): Promise<RequestResponse> {
  let fetchConfig: FetchConfig = {
    url,
    method,
    headers: {
      ...headers,
    },
    body: JSON.stringify(body),
  };

  if (credentials == null) {
    throw {
      type: "missing_credentials",
    };
  }

  fetchConfig = addCredentialsToConfig(fetchConfig, {
    authentication,
    credentials,
  });

  const fetchObject = {
    method: fetchConfig.method,
    headers: fetchConfig.headers,
    body: fetchConfig.body,
  };

  try {
    const fetch = await getFetch();
    const response = await fetch(url, fetchObject);

    const json = await safeGetJson(response);

    return {
      success: response.ok,
      status: response.status,
      headers: normalizeHeaders(response.headers),
      body: json,
    };
  } catch (error: any) {
    return responseFromCaughtError(error);
  }
}
