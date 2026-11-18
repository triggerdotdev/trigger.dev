import { useNavigate } from "@remix-run/react";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { PageBody } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  collapsibleHandleClassName,
  RESIZABLE_PANEL_ANIMATION,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import {
  CompactTokenValues,
  gridIntro,
  keysFor,
  OidcIntro,
  type OidcPageProps,
  ProviderMark,
  ProviderSetup,
  providersMatchedFirst,
  ProviderTile,
  TileGrid,
  useSelectedProvider,
} from "./providers";

/** The provider grid, and the selected provider's setup in the app's resizable side panel. */
export function OidcProvidersPage({ state, setup, replaceable }: OidcPageProps) {
  const { selected, hrefFor } = useSelectedProvider();
  const navigate = useNavigate();
  const isOpen = selected !== null && setup !== null;
  const closeHref = hrefFor(null);

  useShortcutKeys({
    shortcut: { key: "esc" },
    disabled: !isOpen,
    action: () => navigate(closeHref, { replace: true, preventScrollReset: true }),
  });

  return (
    <PageBody scrollable={false}>
      <ResizablePanelGroup orientation="horizontal" className="max-h-full">
        <ResizablePanel id="oidc-main" min="100px">
          <div className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
            <div className="mx-auto mb-12 w-full max-w-6xl space-y-8 p-4 pt-6 sm:px-6">
              <OidcIntro state={state} />
              {setup && (
                <>
                  <CompactTokenValues setup={setup} />
                  <section className="space-y-3">
                    <div className="space-y-1">
                      <Header2>Connect a service</Header2>
                      <Paragraph variant="small">{gridIntro(replaceable)}</Paragraph>
                    </div>
                    <TileGrid>
                      {providersMatchedFirst(replaceable).map((provider) => (
                        <li key={provider.id}>
                          <ProviderTile
                            provider={provider}
                            count={keysFor(replaceable, provider.id).length}
                            selected={selected?.id === provider.id}
                            to={hrefFor(provider.id)}
                          />
                        </li>
                      ))}
                    </TileGrid>
                  </section>
                </>
              )}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle id="oidc-handle" className={collapsibleHandleClassName(isOpen)} />
        <ResizablePanel
          id="oidc-provider"
          min="380px"
          default="440px"
          className="overflow-hidden"
          collapsible
          collapsed={!isOpen}
          onCollapseChange={() => {}}
          collapsedSize="0px"
          collapseAnimation={RESIZABLE_PANEL_ANIMATION}
        >
          <div className="h-full" style={{ minWidth: 380 }}>
            {isOpen && (
              <div className="grid h-full max-h-full grid-rows-[3rem_1fr] overflow-hidden bg-background-bright">
                <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
                  <div className="flex min-w-0 items-center gap-2">
                    <ProviderMark id={selected.id} className="size-7" />
                    <Header2 className="truncate">{selected.name}</Header2>
                  </div>
                  <LinkButton
                    to={closeHref}
                    replace
                    variant="minimal/small"
                    TrailingIcon={ExitIcon}
                    shortcut={{ key: "esc", enabled: false }}
                    shortcutPosition="before-trailing-icon"
                    className="pl-1"
                    aria-label="Close"
                  />
                </div>
                <div className="overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
                  <ProviderSetup
                    provider={selected}
                    setup={setup}
                    keys={keysFor(replaceable, selected.id)}
                  />
                </div>
              </div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </PageBody>
  );
}
