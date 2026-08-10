/** Toggle switch, knob to the left. */
export function ToggleSwitchIcon({ className }: { className?: string }) {
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
        d="M15.5 5H8.5C4.63401 5 1.5 8.13401 1.5 12C1.5 15.866 4.63401 19 8.5 19H15.5C19.366 19 22.5 15.866 22.5 12C22.5 8.13401 19.366 5 15.5 5Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M8.5 15C10.1569 15 11.5 13.6569 11.5 12C11.5 10.3431 10.1569 9 8.5 9C6.84315 9 5.5 10.3431 5.5 12C5.5 13.6569 6.84315 15 8.5 15Z"
        fill="currentColor"
      />
    </svg>
  );
}
