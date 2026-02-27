import { useCallback, useEffect, useRef, useState } from "react";
import { extractDomain, faviconUrl } from "~/utils/favicon";

export function useFaviconUrl(urlInput: string, size: number = 64) {
  const [url, setUrl] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const update = useCallback(
    (value: string) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        const domain = extractDomain(value);
        if (domain && domain.includes(".")) {
          setUrl(faviconUrl(domain, size));
        } else {
          setUrl(null);
        }
      }, 400);
    },
    [size]
  );

  useEffect(() => {
    update(urlInput);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [urlInput, update]);

  return url;
}
