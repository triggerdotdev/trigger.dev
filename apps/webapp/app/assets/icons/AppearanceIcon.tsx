/** Circle with one half filled — the theme/appearance setting. */
export function AppearanceIcon({ className }: { className?: string }) {
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
        d="M12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 16.9706 7.02944 21 12 21Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M12 8C9.79086 8 8 9.79086 8 12C8 14.2091 9.79086 16 12 16V21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3V8ZM12 8C14.2091 8 16 9.79086 16 12C16 14.2091 14.2091 16 12 16V8Z"
        fill="currentColor"
      />
    </svg>
  );
}
