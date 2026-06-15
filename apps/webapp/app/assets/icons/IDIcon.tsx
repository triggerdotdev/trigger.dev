export function IDIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
      <circle cx="9.5" cy="11.5" r="2.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M14 18.5C14 16.0147 11.9853 14 9.5 14C7.01472 14 5 16.0147 5 18.5"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect x="16" y="8" width="5" height="2" rx="1" fill="currentColor" />
      <rect x="16" y="12" width="5" height="2" rx="1" fill="currentColor" />
    </svg>
  );
}
