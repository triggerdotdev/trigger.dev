export function UsageIcon({ className }: { className?: string }) {
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
        d="M9 10C9 9.44771 9.44772 9 10 9H14C14.5523 9 15 9.44772 15 10V20H9V10Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M15 5C15 4.44772 15.4477 4 16 4H20C20.5523 4 21 4.44772 21 5V19C21 19.5523 20.5523 20 20 20H15V5Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M3 15C3 14.4477 3.44772 14 4 14H8C8.55228 14 9 14.4477 9 15V20H4C3.44772 20 3 19.5523 3 19V15Z"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
