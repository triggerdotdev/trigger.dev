export function RolesIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="7" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M7 11C4.28772 11 3.29961 13.0954 3.06142 15.0026C2.99297 15.5507 3.44772 16 4 16H5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="17" cy="11.5" r="2.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M17 17C14.4034 17 13.387 18.5363 13.0961 20.0062C12.9888 20.548 13.4477 21 14 21H20C20.5523 21 21.0112 20.548 20.9039 20.0062C20.613 18.5363 19.5966 17 17 17Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <line
        x1="14.5016"
        y1="3.32229"
        x2="6.32229"
        y2="21.4984"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
