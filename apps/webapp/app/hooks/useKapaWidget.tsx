import { useShortcuts } from "../components/primitives/ShortcutsProvider";
import { useFeatures } from "~/hooks/useFeatures";
import { useCallback, useEffect, useState } from "react";
import { useMatches } from "@remix-run/react";
import { useTypedMatchesData } from "./useTypedMatchData";
import { type loader } from "~/root";

type OpenOptions = { mode: string; query: string; submit: boolean };

declare global {
  interface Window {
    Kapa: (
      command: string,
      options?: (() => void) | OpenOptions,
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
        data-project-color={"#C7D2FE"}
        data-project-logo={"https://content.trigger.dev/trigger-logo-circle.png"}
        data-render-on-load={"false"}
        data-button-hide={"true"}
        data-modal-disclaimer-bg-color={"#1A1B1F"}
        data-modal-disclaimer-text-color={"#878C99"}
        data-modal-header-bg-color={"#2C3034"}
        data-modal-body-bg-color={"#4D525B"}
        data-query-input-text-color={"#15171A"}
        data-query-input-placeholder-text-color={"#878C99"}
        data-modal-title-color={"#D7D9DD"}
        data-button-text-color={"#D7D9DD"}
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

  const handleModalClose = useCallback(() => {
    setIsKapaOpen(false);
    enableShortcuts();
  }, [enableShortcuts]);

  const handleModalOpen = useCallback(() => {
    setIsKapaOpen(true);
    disableShortcuts();
  }, [disableShortcuts]);

  useEffect(() => {
    if (!features.isManagedCloud || !kapa?.websiteId) return;

    window.Kapa("render");
    window.Kapa("onModalOpen", handleModalOpen);
    window.Kapa("onModalClose", handleModalClose);

    return () => {
      window.Kapa("onModalOpen", handleModalOpen, "remove");
      window.Kapa("onModalClose", handleModalClose, "remove");
    };
  }, [features.isManagedCloud, kapa?.websiteId]);

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
