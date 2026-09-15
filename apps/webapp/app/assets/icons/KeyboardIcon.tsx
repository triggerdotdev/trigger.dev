export function KeyboardIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M10.3333 15H13.6667"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="15" r="1" fill="currentColor" />
      <circle cx="7" cy="11" r="1" fill="currentColor" />
      <circle cx="10.3333" cy="11" r="1" fill="currentColor" />
      <circle cx="13.6667" cy="11" r="1" fill="currentColor" />
      <circle cx="17" cy="11" r="1" fill="currentColor" />
      <circle cx="17" cy="15" r="1" fill="currentColor" />
      <rect x="3" y="7" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
