export function TableIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <line x1="9" y1="19" x2="9" y2="5" stroke="currentColor" strokeWidth="2" />
      <line x1="5" y1="9" x2="19" y2="9" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
