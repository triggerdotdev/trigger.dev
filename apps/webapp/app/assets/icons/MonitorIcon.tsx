/** Monitor on a stand — the System theme, which follows the OS appearance. */
export function MonitorIcon({ className }: { className?: string }) {
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
        d="M21 13H3M11 17H13L14 21H10L11 17ZM5 17H19C20.1046 17 21 16.1046 21 15V6C21 4.89543 20.1046 4 19 4H5C3.89543 4 3 4.89543 3 6V15C3 16.1046 3.89543 17 5 17Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
    </svg>
  );
}
