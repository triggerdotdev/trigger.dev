import { addCredentialsToConfig } from "core/authentication/credentials";
import {
  AuthCredentials,
  IntegrationAuthentication,
} from "core/authentication/types";
import { HTTPMethod } from "core/endpoint/types";
import { getFetch, safeGetJson } from "core/request/requestEndpoint";
import { FetchConfig } from "core/request/types";
import { type Response } from "node-fetch";

export type FetchOptions = {
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
}: FetchOptions) {
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

  try {
    const fetch = await getFetch();
    const response = await fetch(url, {
      method,
      headers,
      body,
    });

    const json = await safeGetJson(response);

    return {
      success: response.ok,
      status: response.status,
      headers: response.headers,
      body: json,
    };
  } catch (error) {
    return {
      success: false,
      status: 400,
      headers: {},
      body: error,
    };
  }
}
