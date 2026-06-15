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
        d="M17 9V8C17 5.23858 14.7614 3 12 3C9.23858 3 7 5.23858 7 8V9"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
