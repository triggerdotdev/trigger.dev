"use client";

import { createOpenAPIPage } from "fumadocs-openapi/ui";
import type { AuthProvider } from "fumadocs-openapi/playground";
import { basePath } from "@/lib/base-path";

// With no key yet, example requests show a placeholder instead of an empty `Bearer `. Not an env
// var: the generated curl single-quotes headers, so `$VAR` would never expand.
const secretKeyRequest: AuthProvider["onRequest"] = (data, value) => {
  const token = typeof value === "string" ? value.trim() : "";
  data.header.Authorization = token.includes(" ")
    ? token
    : `Bearer ${token || "<your secret key>"}`;
};

const authProviders: AuthProvider[] = [
  {
    // v3-openapi.yaml calls the scheme `secretKey`, openapi.yml (batches) `BearerAuth`: both take a secret key.
    on: ({ id }) => id === "secretKey" || id === "BearerAuth",
    onRequest: secretKeyRequest,
  },
];

// The spec is preloaded on the server and passed in as props.
export const APIPage = createOpenAPIPage({
  playground: {
    authProviders,
    // app/api/proxy: many API routes don't answer CORS preflights.
    fetchOptions: { proxyUrl: `${basePath}/api/proxy` },
  },
});
