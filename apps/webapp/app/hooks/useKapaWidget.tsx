import { useMatches, useSearchParams } from "@remix-run/react";
import { useCallback, useEffect, useState } from "react";
import { useFeatures } from "~/hooks/useFeatures";
import { type loader } from "~/root";
import { useShortcuts } from "../components/primitives/ShortcutsProvider";
import { useTypedMatchesData } from "./useTypedMatchData";

type OpenOptions = { mode: string; query: string; submit: boolean };

declare global {
  interface Window {
    Kapa: (
      command: string,
      options?: (() => void) | { onRender?: () => void } | OpenOptions,
      remove?: string | { onRender?: () => void }
    ) => void;
  }
}

export function KapaScripts({ websiteId }: { websiteId?: string }) {
  if (!websiteId) return null;

  return (
    <>
      <script
        async
        src="https://widget.kapa.ai/kapa-widget.bundle.js"
        data-website-id={websiteId}
        data-project-name={"Trigger.dev"}
        data-project-color={"#6366F1"}
        data-project-logo={"https://content.trigger.dev/trigger-logo-circle.png"}
        data-render-on-load={"false"}
        data-button-hide={"true"}
        data-modal-disclaimer-bg-color={"#D7D9DD"}
        data-modal-header-bg-color={"#2C3034"}
        data-modal-title-color={"#D7D9DD"}
      ></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
                    (function () {
                      let k = window.Kapa;
                      if (!k) {
                        let i = function () {
                          i.c(arguments);
                        };
                        i.q = [];
                        i.c = function (args) {
                          i.q.push(args);
                        };
                        window.Kapa = i;
                      }
                    })();
                  `,
        }}
      />
    </>
  );
}

export function useKapaConfig() {
  const matches = useMatches();
  const routeMatch = useTypedMatchesData<typeof loader>({
    id: "root",
    matches,
  });
  return routeMatch?.kapa;
}

export function useKapaWidget() {
  const kapa = useKapaConfig();
  const features = useFeatures();
  const { disableShortcuts, enableShortcuts, areShortcutsEnabled } = useShortcuts();
  const [isKapaOpen, setIsKapaOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const handleModalClose = useCallback(() => {
    setIsKapaOpen(false);
    enableShortcuts();
  }, [enableShortcuts]);

  const handleModalOpen = useCallback(() => {
    setIsKapaOpen(true);
    disableShortcuts();
  }, [disableShortcuts]);

  // Handle opening/closing
  useEffect(() => {
    if (!features.isManagedCloud || !kapa?.websiteId) return;

    window.Kapa("render", {
      onRender: () => {
        const aiHelp = searchParams.get("aiHelp");
        if (aiHelp) {
          setSearchParams((prev) => {
            prev.delete("aiHelp");
            return prev;
          });

          //we need to decode the aiHelp string because it's urlencoded
          const decodedAiHelp = decodeURIComponent(aiHelp);
          setTimeout(() => {
            openKapa(decodedAiHelp);
          }, 500);
        }
      },
    });
    window.Kapa("onModalOpen", handleModalOpen);
    window.Kapa("onModalClose", handleModalClose);

    return () => {
      window.Kapa("onModalOpen", handleModalOpen, "remove");
      window.Kapa("onModalClose", handleModalClose, "remove");
    };
  }, [features.isManagedCloud, kapa?.websiteId, searchParams, setSearchParams]);

  // Handle opening the Kapa widget
  const openKapa = useCallback(
    (query?: string) => {
      if (!features.isManagedCloud || !kapa?.websiteId) return;

      window.Kapa(
        "open",
        query
          ? {
              mode: "ai",
              query,
              submit: true,
            }
          : undefined
      );
      setIsKapaOpen(true);
      disableShortcuts();
    },
    [disableShortcuts, features.isManagedCloud, kapa?.websiteId]
  );

  return {
    isKapaEnabled: features.isManagedCloud && kapa?.websiteId,
    openKapa,
    isKapaOpen,
  };
}
