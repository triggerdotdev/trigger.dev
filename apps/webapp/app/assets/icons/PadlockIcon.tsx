export function PadlockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="5" y="9" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="11" y="13" width="2" height="5" rx="1" fill="currentColor" />
      <rect x="10" y="12" width="4" height="4" rx="2" fill="currentColor" />
      <path
        d="M16 8V7C16 4.79086 14.2091 3 12 3C9.79086 3 8 4.79086 8 7V8"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
