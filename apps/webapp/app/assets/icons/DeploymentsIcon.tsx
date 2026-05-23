export function DeploymentsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="2" />
      <circle cx="17.25" cy="8" r="1.25" fill="currentColor" />
      <circle cx="17.25" cy="16" r="1.25" fill="currentColor" />
    </svg>
  );
}
