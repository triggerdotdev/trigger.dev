import { useCallback, useState, useRef, useEffect } from "react";

export function useCopy(value: string, duration = 1500) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const copy = useCallback(
    (e?: React.MouseEvent) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      navigator.clipboard.writeText(value);
      
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      
      setCopied(true);
      timeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, duration);
    },
    [value, duration]
  );

  useEffect(() => {
    setCopied(false);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [value]);

  return { copy, copied };
}
