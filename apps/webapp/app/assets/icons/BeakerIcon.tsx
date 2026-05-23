export function BeakerIcon({ className }: { className?: string }) {
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
        d="M9 10V4H15V10C16.3896 11.737 19.5 15.0137 19.5 17.4324C19.5 19.4768 17.5444 21 15.5 21H8.5C6.45569 21 4.5 19.5444 4.5 17.5C4.5 15.0813 7.6104 11.737 9 10Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="8"
        y1="4"
        x2="16"
        y2="4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line x1="6" y1="14" x2="18" y2="14" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
