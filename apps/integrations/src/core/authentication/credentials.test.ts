import { EndpointSpec } from "core/endpoint/types";
import { HTTPRequest } from "core/request/types";
import { expect, test } from "vitest";
import { checkRequiredScopes, applyCredentials } from "./credentials";
import { AuthCredentials, IntegrationAuthentication } from "./types";

test("Required scopes present", async () => {
  const credentials: AuthCredentials = {
    type: "oauth2",
    name: "authName",
    accessToken: "token",
    scopes: ["scope1", "scope2"],
  };

  const requiredScopes = ["scope1", "scope2"];

  const result = checkRequiredScopes(requiredScopes, credentials);
  expect(result.success).toEqual(true);
});

test("Required scopes missing", async () => {
  const credentials: AuthCredentials = {
    type: "oauth2",
    name: "authName",
    accessToken: "token",
    scopes: ["scope1", "scope2"],
  };

  const requiredScopes = ["scope1", "scope2", "scope3"];

  const result = checkRequiredScopes(requiredScopes, credentials);
  expect(result.success).toEqual(false);
  if (result.success) throw new Error("Should not be success");
  expect(result.missingScopes).toEqual(["scope3"]);
});

test("Applied credentials", async () => {
  const credentials: AuthCredentials = {
    type: "oauth2",
    name: "authName",
    accessToken: "123456",
    scopes: ["scope1", "scope2"],
  };
  const endpointSecurity: EndpointSpec["security"] = {
    authName: ["scope1", "scope2"],
  };

  const integrationAuthentication: IntegrationAuthentication = {
    authName: {
      type: "oauth2",
      placement: {
        in: "header",
        type: "bearer",
        key: "Authorization",
      },
      authorizationUrl: "https://example.com",
      tokenUrl: "https://example.com",
      flow: "accessCode",
      scopes: {
        scope1: "scope1",
        scope2: "scope2",
      },
    },
  };

  const existingFetch: HTTPRequest = {
    url: "https://example.com",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  };

  const fetchConfig = applyCredentials(existingFetch, {
    endpointSecurity,
    authentication: integrationAuthentication,
    credentials,
  });

  expect(fetchConfig.headers.Authorization).toEqual("Bearer 123456");
  expect(fetchConfig.headers["Content-Type"]).toEqual("application/json");
});
