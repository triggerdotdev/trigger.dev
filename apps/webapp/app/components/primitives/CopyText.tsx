import React, { useCallback } from "react";

export type CopyTextProps = {
  children?: React.ReactNode;
  value: string;
  className?: string;
  onCopied?: () => void;
};

export function CopyText({
  children,
  value,
  className,
  onCopied,
}: CopyTextProps) {
  const onClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      navigator.clipboard.writeText(value);
      if (onCopied) {
        onCopied();
      }
    },
    [value, onCopied]
  );

  return (
    <button onClick={onClick} className={`${className}`}>
      {children}
    </button>
  );
}
