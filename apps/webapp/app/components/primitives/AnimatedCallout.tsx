import { useEffect, useRef, useState } from "react";
import { Callout, type CalloutVariant } from "~/components/primitives/Callout";
import { cn } from "~/utils/cn";

const CALLOUT_ANIMATION_MS = 300;

type AnimatedCalloutProps = {
  show: boolean;
  variant: CalloutVariant;
  className?: string;
  children: React.ReactNode;
  /** When set, the callout auto-hides after this many milliseconds. */
  autoHideMs?: number;
  onAutoHide?: () => void;
  onHidden?: () => void;
};

export function AnimatedCallout({
  show,
  variant,
  className,
  children,
  autoHideMs,
  onAutoHide,
  onHidden,
}: AnimatedCalloutProps) {
  const [rendered, setRendered] = useState(show);
  const [autoDismissed, setAutoDismissed] = useState(false);
  const onAutoHideRef = useRef(onAutoHide);
  const onHiddenRef = useRef(onHidden);

  useEffect(() => {
    onAutoHideRef.current = onAutoHide;
  }, [onAutoHide]);

  useEffect(() => {
    onHiddenRef.current = onHidden;
  }, [onHidden]);

  const shouldShow = show && !autoDismissed;

  useEffect(() => {
    if (!show) {
      setAutoDismissed(false);
    }
  }, [show]);

  useEffect(() => {
    if (shouldShow) {
      setRendered(true);
      return;
    }

    if (!rendered) {
      return;
    }

    const hideTimer = window.setTimeout(() => {
      setRendered(false);
      onHiddenRef.current?.();
    }, CALLOUT_ANIMATION_MS);

    return () => window.clearTimeout(hideTimer);
  }, [shouldShow, rendered]);

  useEffect(() => {
    if (!shouldShow || autoHideMs === undefined) {
      return;
    }

    const closeTimer = window.setTimeout(() => {
      setAutoDismissed(true);
      onAutoHideRef.current?.();
    }, autoHideMs);
    return () => window.clearTimeout(closeTimer);
  }, [shouldShow, autoHideMs]);

  if (!rendered) {
    return null;
  }

  return (
    <div
      aria-hidden={!shouldShow}
      className={cn(
        "transition-opacity duration-300",
        shouldShow ? "opacity-100" : "pointer-events-none opacity-0",
        className
      )}
    >
      <Callout variant={variant}>{children}</Callout>
    </div>
  );
}
