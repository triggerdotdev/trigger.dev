export function UserCrossIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="10" cy="6" r="3" stroke="currentColor" strokeWidth="2" />
      <path
        d="M10 12C4.94135 12 3.30992 15.808 3.04178 19.0013C2.99557 19.5517 3.44772 20 4 20H16C16.5523 20 17.0044 19.5517 16.9582 19.0013C16.6901 15.808 15.0587 12 10 12Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <line
        x1="17"
        y1="12.4156"
        x2="21.2426"
        y2="8.17298"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="16.9142"
        y1="8.17297"
        x2="21.1569"
        y2="12.4156"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
