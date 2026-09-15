export function MessageOutputIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M13 3H6C4.34315 3 3 4.34315 3 6V18C3 19.6569 4.34315 21 6 21H13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="15" cy="12" r="2" fill="currentColor" />
      <circle cx="20" cy="12" r="2" fill="currentColor" />
      <circle cx="10" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}
