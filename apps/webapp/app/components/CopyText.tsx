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
    (event: React.MouseEvent<HTMLDivElement>) => {
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
    <div onClick={onClick} className={`${className}`}>
      {children}
    </div>
  );
}
