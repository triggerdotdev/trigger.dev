import { useCallback, useEffect, useRef, useState } from "react";
import { extractDomain, faviconUrl } from "~/utils/favicon";

function resolve(input: string, size: number): string | null {
  const domain = extractDomain(input);
  return domain && domain.includes(".") ? faviconUrl(domain, size) : null;
}

export function useFaviconUrl(urlInput: string, size: number = 64) {
  const [url, setUrl] = useState<string | null>(() => resolve(urlInput, size));
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setUrl(resolve(urlInput, size));
    }, 400);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [urlInput, size]);

  return url;
}
