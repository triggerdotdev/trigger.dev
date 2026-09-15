export function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <line
        x1="12"
        y1="7"
        x2="12"
        y2="12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M15.5 15.5L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
