import { useLocation } from "@remix-run/react";
import { useEffect, useRef } from "react";

/** Scroll a page body container back to the top when navigating to a route. */
export function useScrollContainerToTop<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const location = useLocation();

  useEffect(() => {
    ref.current?.scrollTo(0, 0);
  }, [location.key]);

  return ref;
}
