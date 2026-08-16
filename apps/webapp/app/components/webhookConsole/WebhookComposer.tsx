import { PlusIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { CodeBlock } from "~/components/code/CodeBlock";
import { JSONEditor } from "~/components/code/JSONEditor";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Select, SelectItem } from "~/components/primitives/Select";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { cn } from "~/utils/cn";
import type { WebhookSendResult } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.webhooks.endpoints.$endpointParam.send";
import { AIPayloadTabContent } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.test.tasks.$taskParam/AIPayloadTabContent";
import { ReplaySourcePicker } from "./ReplaySourcePicker";
import { SampleSourcePicker } from "./SampleSourcePicker";

type SourceTab = "body" | "sample" | "replay" | "ai";

export type WebhookComposerEndpoint = {
  friendlyId: string;
  label: string;
  source: string;
  ingressUrl: string;
  scheme: "hmac" | "shared-secret" | "url-secret" | "asymmetric";
  hasSigningSecret: boolean;
  handshake: { matchPath: string; matchValue: string; respondPath: string } | null;
};

export type WebhookComposerProps = {
  endpoints: WebhookComposerEndpoint[];
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  isDevEnvironment: boolean;
  environmentLabel: string;
  defaultBody?: string;
  /** When false, a successful send stays put and shows the inline result strip instead of
   * redirecting to the delivery detail page (the console tab keeps its live feed alongside). */
  redirectOnSuccess?: boolean;
};

type SignatureMode = "signed" | "unsigned" | "tampered" | "simulate";

type HeaderRow = { id: string; key: string; value: string };

const DEFAULT_BODY = JSON.stringify({ message: "hello from the webhook console" }, null, 2);

export function WebhookComposer({
  endpoints,
  organizationSlug,
  projectSlug,
  environmentSlug,
  isDevEnvironment,
  environmentLabel,
  defaultBody,
  redirectOnSuccess = true,
}: WebhookComposerProps) {
  const fetcher = useFetcher<WebhookSendResult>();
  const isSending = fetcher.state !== "idle";

  const [endpointId, setEndpointId] = useState(endpoints[0]?.friendlyId ?? "");
  const [sourceTab, setSourceTab] = useState<SourceTab>("body");
  const [bodyDefault, setBodyDefault] = useState(defaultBody ?? DEFAULT_BODY);
  const bodyRef = useRef(bodyDefault);
  const [payloadReloadKey, setPayloadReloadKey] = useState(0);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const headerIdRef = useRef(0);

  const newHeaderRow = useCallback(
    (key = "", value = ""): HeaderRow => ({ id: String(headerIdRef.current++), key, value }),
    []
  );

  const endpoint = useMemo(
    () => endpoints.find((e) => e.friendlyId === endpointId) ?? endpoints[0],
    [endpoints, endpointId]
  );

  const applyPayload = useCallback(
    (body: string, headers: Record<string, string>) => {
      setBodyDefault(body);
      bodyRef.current = body;
      setPayloadReloadKey((key) => key + 1);
      const entries = Object.entries(headers);
      setHeaderRows(entries.map(([key, value]) => newHeaderRow(key, value)));
      setSourceTab("body");
    },
    [newHeaderRow]
  );

  const signedAvailable = Boolean(
    endpoint && endpoint.scheme !== "asymmetric" && endpoint.hasSigningSecret
  );
  const signedDisabledReason = !endpoint
    ? undefined
    : endpoint.scheme === "asymmetric"
      ? "This endpoint uses asymmetric signatures, which cannot be produced here."
      : !endpoint.hasSigningSecret
        ? "Set a signing secret on this endpoint first."
        : undefined;

  const [signatureMode, setSignatureMode] = useState<SignatureMode>(
    signedAvailable ? "signed" : "simulate"
  );

  const endpointBasePath = endpoint
    ? `/resources/orgs/${organizationSlug}/projects/${projectSlug}/env/${environmentSlug}/webhooks/endpoints/${endpoint.friendlyId}`
    : "";
  const sendPath = endpointBasePath ? `${endpointBasePath}/send` : "";
  const replaySourcePath = endpointBasePath ? `${endpointBasePath}/replay-source` : "";
  const samplesPath = `/resources/orgs/${organizationSlug}/projects/${projectSlug}/env/${environmentSlug}/webhooks/samples`;

  function submit(override?: {
    body?: string;
    signatureMode?: SignatureMode;
    headers?: Record<string, string>;
  }) {
    if (!endpoint) return;
    let headers = override?.headers;
    if (!headers) {
      headers = {};
      for (const row of headerRows) {
        const key = row.key.trim();
        if (key) headers[key] = row.value;
      }
    }
    fetcher.submit(
      {
        body: override?.body ?? bodyRef.current,
        headers,
        signatureMode: override?.signatureMode ?? signatureMode,
        redirect: redirectOnSuccess,
      },
      { method: "post", action: sendPath, encType: "application/json" }
    );
  }

  function sendHandshake() {
    if (!endpoint?.handshake) return;
    const challenge = `chal_${Math.random().toString(36).slice(2, 10)}`;
    const body = JSON.stringify(buildHandshakeBody(endpoint.handshake, challenge), null, 2);
    applyPayload(body, {});
    submit({ body, signatureMode: "signed", headers: {} });
  }

  const result = fetcher.data;
  const deliveryPath =
    result?.success && result.deliveryId?.startsWith("whd_")
      ? `/orgs/${organizationSlug}/projects/${projectSlug}/env/${environmentSlug}/webhooks/deliveries/${result.deliveryId}`
      : undefined;

  return (
    <div className="flex h-full max-h-full flex-col">
      <ResizablePanelGroup orientation="horizontal" className="grow">
        <ResizablePanel id="webhook-composer-editor" min="360px">
          <div className="flex h-full flex-col overflow-hidden bg-charcoal-900">
            <div className="flex h-9 items-center border-b border-grid-dimmed bg-background-bright px-3">
              <TabContainer className="-mb-px">
                <TabButton
                  isActive={sourceTab === "body"}
                  layoutId="webhook-composer-source"
                  onClick={() => setSourceTab("body")}
                >
                  Body
                </TabButton>
                <TabButton
                  isActive={sourceTab === "sample"}
                  layoutId="webhook-composer-source"
                  onClick={() => setSourceTab("sample")}
                >
                  Library
                </TabButton>
                <TabButton
                  isActive={sourceTab === "replay"}
                  layoutId="webhook-composer-source"
                  onClick={() => setSourceTab("replay")}
                >
                  Replay
                </TabButton>
                <TabButton
                  isActive={sourceTab === "ai"}
                  layoutId="webhook-composer-source"
                  onClick={() => setSourceTab("ai")}
                >
                  AI
                </TabButton>
              </TabContainer>
            </div>
            <div className="relative flex-1 overflow-hidden">
              <div className={cn("h-full", sourceTab !== "body" && "hidden")}>
                <JSONEditor
                  key={payloadReloadKey}
                  defaultValue={bodyDefault}
                  readOnly={false}
                  basicSetup
                  autoFocus
                  onChange={(v) => {
                    bodyRef.current = v;
                  }}
                  height="100%"
                  className="h-full overflow-auto"
                  showClearButton={false}
                  additionalActions={
                    <span className="text-xs font-medium text-text-dimmed">Event body</span>
                  }
                />
              </div>
              {sourceTab === "sample" ? (
                <div className="absolute inset-0">
                  <SampleSourcePicker
                    samplesPath={samplesPath}
                    endpointSource={endpoint?.source}
                    onLoad={applyPayload}
                  />
                </div>
              ) : null}
              {sourceTab === "replay" ? (
                <div className="absolute inset-0">
                  <ReplaySourcePicker replaySourcePath={replaySourcePath} onLoad={applyPayload} />
                </div>
              ) : null}
              {sourceTab === "ai" ? (
                <div className="absolute inset-0 overflow-y-auto bg-charcoal-900 p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                  <AIPayloadTabContent
                    onPayloadGenerated={(payload) => applyPayload(payload, {})}
                    taskIdentifier={endpoint?.source ?? "webhook"}
                    payloadKind="webhook"
                    providerSource={endpoint?.source}
                    generateButtonLabel="Generate event"
                    placeholder="e.g. a payment succeeded event with a $42.00 charge"
                  />
                </div>
              ) : null}
            </div>
            {result ? (
              <div className="max-h-72 shrink-0 overflow-y-auto border-t border-grid-dimmed bg-background-dimmed p-3">
                <ResultStrip result={result} deliveryPath={deliveryPath} />
              </div>
            ) : null}
          </div>
        </ResizablePanel>

        <ResizableHandle id="webhook-composer-handle" />

        <ResizablePanel
          id="webhook-composer-options"
          min="280px"
          default="360px"
          max="480px"
          isStaticAtRest
        >
          <div className="flex h-full flex-col gap-4 overflow-y-auto bg-background-bright p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            {!isDevEnvironment ? (
              <Callout variant="warning">
                Sends a real delivery through the {environmentLabel} endpoint and triggers a real
                run.
              </Callout>
            ) : null}

            {endpoints.length > 1 ? (
              <InputGroup>
                <Label variant="small">Endpoint</Label>
                <Select
                  variant="tertiary/small"
                  dropdownIcon
                  value={endpointId}
                  setValue={(v) => {
                    if (Array.isArray(v)) return;
                    setEndpointId(v);
                  }}
                  items={endpoints.map((e) => e.friendlyId)}
                >
                  {endpoints.map((e) => (
                    <SelectItem key={e.friendlyId} value={e.friendlyId}>
                      {e.label}
                    </SelectItem>
                  ))}
                </Select>
              </InputGroup>
            ) : null}

            <InputGroup>
              <Label variant="small">Signature</Label>
              <Select
                variant="tertiary/small"
                dropdownIcon
                value={signatureMode}
                setValue={(v) => {
                  if (Array.isArray(v)) return;
                  setSignatureMode(v as SignatureMode);
                }}
                items={["signed", "simulate", "unsigned", "tampered"]}
              >
                <SelectItem value="signed" disabled={!signedAvailable}>
                  Signed (valid)
                </SelectItem>
                <SelectItem value="simulate">Simulate (skip verification)</SelectItem>
                <SelectItem value="unsigned">Unsigned (expect 400)</SelectItem>
                <SelectItem value="tampered">Tampered (expect 400)</SelectItem>
              </Select>
              {signatureMode === "signed" && signedDisabledReason ? (
                <Hint>{signedDisabledReason}</Hint>
              ) : signatureMode === "signed" ? (
                <Hint>Signed server-side with the endpoint's stored secret.</Hint>
              ) : signatureMode === "simulate" ? (
                <Hint>
                  Injected via the engine, skipping signature verification. Filter, startOn,
                  routing, and the run all still execute.
                </Hint>
              ) : (
                <Hint>The delivery is rejected fail-closed; no delivery row is written.</Hint>
              )}
            </InputGroup>

            <InputGroup>
              <Label variant="small">Headers</Label>
              <HeadersEditor
                rows={headerRows}
                onChange={setHeaderRows}
                onAdd={() => setHeaderRows((rows) => [...rows, newHeaderRow()])}
              />
              <Hint>
                Optional provider routing headers (e.g. x-github-event). The signature header is
                added automatically.
              </Hint>
            </InputGroup>

            {endpoint ? (
              <InputGroup>
                <Label variant="small">Webhook URL</Label>
                <ClipboardField
                  value={endpoint.ingressUrl}
                  variant="secondary/small"
                  className="font-mono"
                  icon={
                    <span className="pl-1 font-mono text-xxs font-semibold uppercase text-text-dimmed">
                      POST
                    </span>
                  }
                />
                <Hint>
                  The public URL providers POST to. Test sends run the same pipeline in-process.
                </Hint>
              </InputGroup>
            ) : null}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <div className="flex items-center justify-between gap-3 border-t border-grid-bright bg-background-dimmed p-2">
        <span className="text-xs text-text-dimmed">
          {isDevEnvironment
            ? "Signs with the endpoint's secret and runs the full delivery pipeline."
            : `Sends through the ${environmentLabel} endpoint.`}
        </span>
        <div className="flex items-center gap-2">
          {endpoint?.handshake && signedAvailable ? (
            <Button
              variant="tertiary/small"
              onClick={() => sendHandshake()}
              disabled={isSending || !endpoint}
              tooltip="Send a signed handshake and assert the endpoint echoes the challenge"
            >
              Send handshake
            </Button>
          ) : null}
          {isDevEnvironment ? (
            <Button
              variant="primary/small"
              onClick={() => submit()}
              disabled={isSending || !endpoint}
            >
              {isSending ? "Sending…" : "Send event"}
            </Button>
          ) : (
            <ConfirmSendDialog
              environmentLabel={environmentLabel}
              disabled={isSending || !endpoint}
              isSending={isSending}
              onConfirm={() => submit()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function HeadersEditor({
  rows,
  onChange,
  onAdd,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <Input
              variant="small"
              placeholder="Header"
              value={row.key}
              spellCheck={false}
              className="font-mono"
              onChange={(event) =>
                onChange(rows.map((r) => (r.id === row.id ? { ...r, key: event.target.value } : r)))
              }
            />
          </div>
          <div className="min-w-0 flex-1">
            <Input
              variant="small"
              placeholder="Value"
              value={row.value}
              spellCheck={false}
              className="font-mono"
              onChange={(event) =>
                onChange(
                  rows.map((r) => (r.id === row.id ? { ...r, value: event.target.value } : r))
                )
              }
            />
          </div>
          <button
            type="button"
            aria-label="Remove header"
            onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
            className="shrink-0 rounded p-1 text-text-dimmed transition-colors hover:bg-charcoal-700 hover:text-text-bright"
          >
            <XMarkIcon className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={onAdd}
        className="flex w-fit items-center gap-1 rounded py-0.5 pr-1.5 text-xs text-text-dimmed transition-colors hover:text-text-bright"
      >
        <PlusIcon className="size-3.5" />
        Add header
      </button>
    </div>
  );
}

const UNSAFE_PATH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  if (parts.some((part) => UNSAFE_PATH_KEYS.has(part))) {
    return;
  }
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cursor[key];
    if (typeof next !== "object" || next === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function buildHandshakeBody(
  handshake: { matchPath: string; matchValue: string; respondPath: string },
  challenge: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  setPath(body, handshake.matchPath, handshake.matchValue);
  setPath(body, handshake.respondPath, challenge);
  return body;
}

function ConfirmSendDialog({
  environmentLabel,
  disabled,
  isSending,
  onConfirm,
}: {
  environmentLabel: string;
  disabled: boolean;
  isSending: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary/small" disabled={disabled}>
          {isSending ? "Sending…" : "Send event"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>Send to {environmentLabel}?</DialogHeader>
        <div className="flex flex-col gap-3 pt-2">
          <p className="text-sm text-text-dimmed">
            This delivers a real event to a non-development endpoint and triggers a real run.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary/small"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Send to {environmentLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResultStrip({
  result,
  deliveryPath,
}: {
  result: WebhookSendResult;
  deliveryPath?: string;
}) {
  const status = result.success ? result.httpStatus : undefined;
  const handshake = result.success && result.handshake;
  const deduplicated = result.success && result.deduplicated;
  const ok = result.success && status === 200 && !deduplicated;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-xs font-medium",
            handshake
              ? "bg-blue-500/20 text-blue-400"
              : deduplicated
                ? "bg-amber-500/20 text-amber-400"
                : ok
                  ? "bg-success/20 text-success"
                  : "bg-error/20 text-error"
          )}
        >
          {handshake
            ? "Handshake"
            : deduplicated
              ? "Deduplicated"
              : result.success
                ? `HTTP ${result.httpStatus}`
                : "Failed"}
        </span>
        {result.success && result.deliveryId ? (
          <span className="font-mono text-xs text-text-dimmed">{result.deliveryId}</span>
        ) : null}
        {deliveryPath ? (
          <LinkButton variant="minimal/small" to={deliveryPath} className="ml-auto">
            {deduplicated ? "View original →" : "View delivery →"}
          </LinkButton>
        ) : null}
      </div>
      {handshake ? (
        <Hint>
          Challenge echoed by the endpoint. Handshakes are answered inline; no delivery is recorded.
        </Hint>
      ) : deduplicated ? (
        <Hint>
          Identical payload was deduplicated to the original delivery. Vary it to send a new one.
        </Hint>
      ) : null}
      <CodeBlock
        code={result.success ? result.responseBody : result.error}
        language="json"
        showLineNumbers={false}
        maxLines={8}
      />
    </div>
  );
}
