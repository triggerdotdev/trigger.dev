import { useEffect, useState } from "react";
import { CARD_GAP } from "~/components/alerts/wizardSteps";

// A bottom-anchored wizard card fits the transcript viewport above it.
export function useWizardMaxHeight(viewport: Element | null | undefined): number | undefined {
  const [room, setRoom] = useState(0);
  useEffect(() => {
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setRoom(entry?.contentRect.height ?? 0));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);
  return room > CARD_GAP ? room - CARD_GAP : undefined;
}
