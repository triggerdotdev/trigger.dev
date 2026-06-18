export function MessageInputIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="4" cy="12" r="2" fill="currentColor" />
      <circle cx="14" cy="12" r="2" fill="currentColor" />
      <circle cx="9" cy="12" r="2" fill="currentColor" />
      <path
        d="M11 21L18 21C19.6569 21 21 19.6569 21 18L21 6C21 4.34315 19.6569 3 18 3L11 3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
