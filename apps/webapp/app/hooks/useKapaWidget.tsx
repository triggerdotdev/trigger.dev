import { useKapaConfig } from "~/root";
import { useShortcuts } from "../components/primitives/ShortcutsProvider";
import { useFeatures } from "~/hooks/useFeatures";
import { useCallback, useEffect, useState } from "react";

export function useKapaWidget() {
  const kapa = useKapaConfig();
  const features = useFeatures();
  const { disableShortcuts, enableShortcuts, areShortcutsEnabled } = useShortcuts();
  const [isKapaOpen, setIsKapaOpen] = useState(false);

  useEffect(() => {
    if (!features.isManagedCloud || !kapa?.websiteId) return;

    loadScriptIfNotExists(kapa.websiteId);

    // Define the handler function
    const handleModalClose = () => {
      setIsKapaOpen(false);
      enableShortcuts();
    };

    const kapaInterval = setInterval(() => {
      if (typeof window.Kapa === "function") {
        clearInterval(kapaInterval);
        window.Kapa("render");
        window.Kapa("onModalClose", handleModalClose);

        // Register onModalOpen handler
        window.Kapa("onModalOpen", () => {
          setIsKapaOpen(true);
          disableShortcuts();
        });
      }
    }, 100);

    // Clear interval on unmount to prevent memory leaks
    return () => {
      clearInterval(kapaInterval);
      if (typeof window.Kapa === "function") {
        window.Kapa("unmount");
      }
    };
  }, [features.isManagedCloud, kapa?.websiteId, disableShortcuts, enableShortcuts]);

  const openKapa = useCallback(() => {
    if (!features.isManagedCloud || !kapa?.websiteId) return;

    if (typeof window.Kapa === "function") {
      window.Kapa("open");
      setIsKapaOpen(true);
      disableShortcuts();
    }
  }, [disableShortcuts, features.isManagedCloud, kapa?.websiteId]);

  return {
    isKapaEnabled: features.isManagedCloud && kapa?.websiteId,
    openKapa,
    isKapaOpen,
  };
}

function loadScriptIfNotExists(websiteId: string) {
  const scriptSrc = "https://widget.kapa.ai/kapa-widget.bundle.js";

  if (document.querySelector(`script[src="${scriptSrc}"]`)) {
    return;
  }

  const script = document.createElement("script");
  script.async = true;
  script.src = scriptSrc;

  const attributes = {
    "data-website-id": websiteId,
    "data-project-name": "Trigger.dev",
    "data-project-color": "#6366F1",
    "data-project-logo": "https://content.trigger.dev/trigger-logo-triangle.png",
    "data-render-on-load": "false",
    "data-button-hide": "true",
    "data-modal-disclaimer-bg-color": "#1A1B1F",
    "data-modal-disclaimer-text-color": "#878C99",
  };

  Object.entries(attributes).forEach(([key, value]) => {
    script.setAttribute(key, value);
  });

  document.head.appendChild(script);
}
