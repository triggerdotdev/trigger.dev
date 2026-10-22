// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@remix-run/react", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: any) => createElement("a", { href: props.to }, props.children),
  Form: (props: any) => createElement("form", props),
  useActionData: () => undefined,
  useNavigation: () => ({ state: "idle" }),
  useNavigate: () => () => {},
}));
vi.mock("~/hooks/useOrganizations", () => ({ useOrganization: () => ({ slug: "org" }) }));
vi.mock("~/hooks/useProject", () => ({ useProject: () => ({ slug: "proj" }) }));
vi.mock("~/hooks/useEnvironment", () => ({ useEnvironment: () => ({ slug: "prod" }) }));

const { AlertChannelForm } = await import("./AlertChannelForm");

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function render(mode: "create" | "edit", slack: any = { status: "NOT_AVAILABLE" }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(AlertChannelForm, {
            inline: true,
            mode,
            slack,
            emailAlertsEnabled: true,
            defaultType: "SLACK",
            defaultChannelValue: "C123/ops",
          })
        )
      )
    )
  );
  return container;
}

describe("AlertChannelForm without a Slack integration", () => {
  it("submits the existing channel value in edit mode", () => {
    const input = render("edit").querySelector<HTMLInputElement>(
      'input[type="hidden"][name="channelValue"]'
    );
    expect(input?.value).toBe("C123/ops");
  });

  it("does not add a hidden channel value in create mode", () => {
    expect(render("create").querySelector('input[name="channelValue"]')).toBeNull();
  });

  it("does not add a hidden channel value when Slack is ready", () => {
    const slack = {
      status: "READY",
      integrationId: "int_1",
      channels: [{ id: "C123", name: "ops", is_private: false }],
    };
    expect(
      render("edit", slack).querySelector('input[type="hidden"][name="channelValue"]')
    ).toBeNull();
  });
});
