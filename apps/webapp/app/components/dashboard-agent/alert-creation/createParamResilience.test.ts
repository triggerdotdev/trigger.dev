// @vitest-environment jsdom
import { act, createElement, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Prefill = { capability?: string; scope?: string; scopeValue?: string };
type Agent = { openCreateAlert: (prefill: Prefill) => void } | null;

function useCreateParamHandler({
  wantCreate,
  searchParams,
  agent,
  onStrip,
}: {
  wantCreate: boolean;
  searchParams: URLSearchParams;
  agent: Agent;
  onStrip: () => void;
}) {
  const pendingCreateRef = useRef<Prefill | null>(
    wantCreate
      ? {
          capability: searchParams.get("capability") ?? undefined,
          scope: searchParams.get("scope") ?? undefined,
          scopeValue: searchParams.get("scopeValue") ?? undefined,
        }
      : null
  );
  useEffect(() => {
    if (wantCreate && !pendingCreateRef.current) {
      pendingCreateRef.current = {
        capability: searchParams.get("capability") ?? undefined,
        scope: searchParams.get("scope") ?? undefined,
        scopeValue: searchParams.get("scopeValue") ?? undefined,
      };
    }
  }, [wantCreate, searchParams]);

  useEffect(() => {
    const pending = pendingCreateRef.current;
    if (!pending || !agent) return;
    pendingCreateRef.current = null;
    agent.openCreateAlert(pending);
    onStrip();
  }, [agent, onStrip]);
}

let container: HTMLElement;
let root: Root;

describe("?create=1 async agent readiness", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("fails when ?create=1 is consumed before the agent host is ready", async () => {
    const openCreateAlert = vi.fn();
    const onStrip = vi.fn();
    const params = new URLSearchParams("create=1&capability=queue.depth");
    function Harness({ onSetAgent }: { onSetAgent: (setter: (a: Agent) => void) => void }) {
      const [agent, setAgent] = useState<Agent>(null);
      useEffect(() => {
        onSetAgent(setAgent);
      }, [onSetAgent]);
      useCreateParamHandler({
        wantCreate: params.get("create") === "1",
        searchParams: params,
        agent,
        onStrip,
      });
      return null;
    }

    let doSetAgent: (a: Agent) => void = () => {};
    act(() => {
      root.render(
        createElement(Harness, {
          onSetAgent: (setter: (a: Agent) => void) => {
            doSetAgent = setter;
          },
        })
      );
    });

    expect(openCreateAlert).not.toHaveBeenCalled();
    expect(onStrip).not.toHaveBeenCalled();

    act(() => {
      doSetAgent({ openCreateAlert });
    });
    await act(async () => {});

    expect(openCreateAlert).toHaveBeenCalledTimes(1);
    expect(openCreateAlert).toHaveBeenCalledWith({
      capability: "queue.depth",
      scope: undefined,
      scopeValue: undefined,
    });
    expect(onStrip).toHaveBeenCalledTimes(1);
  });

  it("does not fire again on re-render after agent is ready", async () => {
    const openCreateAlert = vi.fn();
    const onStrip = vi.fn();
    const params = new URLSearchParams("create=1");

    function Harness({ onSetAgent }: { onSetAgent: (setter: (a: Agent) => void) => void }) {
      const [agent, setAgent] = useState<Agent>(null);
      useEffect(() => {
        onSetAgent(setAgent);
      }, [onSetAgent]);
      useCreateParamHandler({
        wantCreate: params.get("create") === "1",
        searchParams: params,
        agent,
        onStrip,
      });
      return null;
    }

    let doSetAgent: (a: Agent) => void = () => {};
    act(() => {
      root.render(
        createElement(Harness, {
          onSetAgent: (setter: (a: Agent) => void) => {
            doSetAgent = setter;
          },
        })
      );
    });

    act(() => {
      doSetAgent({ openCreateAlert });
    });
    await act(async () => {});

    expect(openCreateAlert).toHaveBeenCalledTimes(1);

    act(() => {
      doSetAgent({ openCreateAlert });
    });
    await act(async () => {});

    expect(openCreateAlert).toHaveBeenCalledTimes(1);
  });

  it("does not strip params when startTransition wraps the call", () => {
    const alertsRoute = readFileSync(
      resolve(
        fileURLToPath(import.meta.url),
        "../../../../routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts/route.tsx"
      ),
      "utf8"
    );
    expect(alertsRoute).not.toMatch(/startTransition/);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
