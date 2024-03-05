export function ExitIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="3.5" y1="8" x2="11.5" y2="8" stroke="currentColor" strokeLinecap="round" />
      <line x1="15.5" y1="1.5" x2="15.5" y2="14.5" stroke="currentColor" strokeLinecap="round" />
      <path
        d="M8.5 4.5L12 8L8.5 11.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
