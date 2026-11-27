"use client";

import { createContext, useContext, useEffect, useState, type ComponentProps } from "react";
import { createOpenAPIPage } from "fumadocs-openapi/ui";
import {
  Custom,
  DefaultResultDisplay,
  type ParameterFieldContext,
} from "fumadocs-openapi/ui/playground/client";
import {
  usePlaygroundAuth,
  type AuthProvider,
  type AuthRenderProps,
} from "fumadocs-openapi/playground";
import { DocsKeyHint } from "./docs-key-hint";
import { personalizationEnabled } from "@/lib/dashboard-link";
import { forgetRejectedKey, playgroundKey, useCoveringKey, useDocsKeys } from "@/lib/docs-keys";
import { useReaderProject } from "@/lib/reader";
import { basePath } from "@/lib/base-path";

// The access this page's endpoint needs (`x-trigger-access`), for the playground's auth row.
const EndpointAccess = createContext<string[] | null>(null);
const noAccess: string[] = [];

/** The bearer token row: filled with the first docs key in this tab that can call the endpoint,
 * or a one-click key with exactly the access it needs. Still editable. */
function SecretKeyAuth({ field, Value }: AuthRenderProps) {
  const project = useReaderProject();
  const access = useContext(EndpointAccess);
  const needed = access ?? noAccess;
  const key = useCoveringKey(project, needed);
  const keys = useDocsKeys();
  const { stf } = usePlaygroundAuth();

  useEffect(() => {
    const next = playgroundKey(stf.dataEngine.get(field.fieldName), key);
    if (next !== undefined) stf.dataEngine.update(field.fieldName, next);
  }, [key, keys, stf, field.fieldName]);

  return (
    <>
      {project && <DocsKeyHint project={project} needed={needed} access={access} what="endpoint" />}
      <Value
        name="Authorization"
        type="header"
        start="Bearer"
        description={field.scheme.description}
      />
    </>
  );
}

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
    ...(personalizationEnabled ? { render: SecretKeyAuth } : {}),
    onRequest: secretKeyRequest,
  },
];

// The Authorization the playground last sent, so a 401 can be matched to the key that caused it.
let lastAuthorization: string | null = null;
const rememberAuthorization = (init: RequestInit) => {
  lastAuthorization = new Headers(init.headers).get("Authorization");
  return init;
};

type ResultDisplayProps = ComponentProps<typeof DefaultResultDisplay>;

/** The playground's response, plus a note when it shows a docs key was revoked or expired. */
function ResultDisplay(props: ResultDisplayProps) {
  const { data } = props;
  const [revoked, setRevoked] = useState(false);
  useEffect(() => {
    if (data.type !== "response") return;
    if (forgetRejectedKey(data.status, lastAuthorization)) setRevoked(true);
    else if (data.status !== 401) setRevoked(false);
  }, [data]);
  return (
    <>
      {revoked && (
        <p role="alert" className="px-3 pt-3 text-sm text-fd-error">
          That key was revoked or expired. Create a new one.
        </p>
      )}
      <DefaultResultDisplay {...props} />
    </>
  );
}

type FieldKey = Parameters<typeof Custom.useController>[0];

/** The `projectRef` path parameter, set to the reader's project (still editable). */
function ProjectRefField({ fieldName, ctx }: { fieldName: FieldKey; ctx: ParameterFieldContext }) {
  const ref = useReaderProject()?.ref;
  const { setValue } = Custom.useController(fieldName);
  useEffect(() => {
    if (ref) setValue(ref);
  }, [ref, setValue]);
  return ctx.renderDefault();
}

const OpenAPIPage = createOpenAPIPage({
  playground: {
    authProviders,
    // app/api/proxy: many API routes don't answer CORS preflights.
    fetchOptions: {
      proxyUrl: `${basePath}/api/proxy`,
      ...(personalizationEnabled ? { onRequestInit: rememberAuthorization } : {}),
    },
    ...(personalizationEnabled ? { components: { ResultDisplay } } : {}),
    renderParameterField: personalizationEnabled
      ? (fieldName, param, ctx) =>
          param.in === "path" && param.name === "projectRef" ? (
            <ProjectRefField fieldName={fieldName} ctx={ctx} />
          ) : undefined
      : undefined,
  },
});

// The spec is preloaded on the server and passed in as props.
export function APIPage({
  access,
  ...props
}: ComponentProps<typeof OpenAPIPage> & { access: string[] | null }) {
  return (
    <EndpointAccess.Provider value={access}>
      <OpenAPIPage {...props} />
    </EndpointAccess.Provider>
  );
}
