import { useEffect, useRef } from "react";

export type TurnstileStatus = "pending" | "ready" | "error";

type TurnstileApi = {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }

  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) {
        resolve(window.turnstile);
      } else {
        scriptPromise = undefined;
        reject(new Error("Turnstile didn't initialize"));
      }
    };
    script.onerror = () => {
      scriptPromise = undefined;
      script.remove();
      reject(new Error("Turnstile failed to load"));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}

/**
 * Renders a Cloudflare Turnstile widget inside the surrounding form. Turnstile
 * adds a hidden `cf-turnstile-response` input to the container, so the token is
 * submitted with the form. Tokens are single use: remount the widget (change its
 * `key`) after each submission.
 */
export function TurnstileWidget({
  siteKey,
  action,
  onStatusChange,
}: {
  siteKey: string;
  action: string;
  onStatusChange?: (status: TurnstileStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    let cancelled = false;
    let widgetId: string | undefined;
    const report = (status: TurnstileStatus) => {
      if (!cancelled) onStatusChangeRef.current?.(status);
    };

    report("pending");
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme: "dark",
          appearance: "interaction-only",
          "refresh-expired": "auto",
          callback: () => report("ready"),
          "expired-callback": () => report("pending"),
          "error-callback": () => report("error"),
        });
      })
      .catch(() => report("error"));

    return () => {
      cancelled = true;
      if (widgetId) {
        window.turnstile?.remove(widgetId);
      }
    };
  }, [siteKey, action]);

  return <div ref={containerRef} className="flex w-full justify-center empty:hidden" />;
}
