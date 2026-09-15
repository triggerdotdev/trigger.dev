export function TasksIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect
        width="8.993"
        height="2"
        rx="1"
        transform="matrix(1 0 0 -1 7.5035 9)"
        fill="currentColor"
      />
      <path
        d="M11 8.49536L11 16.4954C11 17.0476 11.4477 17.4954 12 17.4954C12.5523 17.4954 13 17.0476 13 16.4954L13 8.49536L11 8.49536Z"
        fill="currentColor"
      />
    </svg>
  );
}
