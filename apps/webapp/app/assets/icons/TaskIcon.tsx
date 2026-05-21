export function TaskIcon({ className }: { className?: string }) {
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

export function TaskIconSmall({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4 3H16C16.5523 3 17 3.44772 17 4V16C17 16.5523 16.5523 17 16 17H4C3.44772 17 3 16.5523 3 16V4L3.00488 3.89746C3.05621 3.39333 3.48232 3 4 3Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect width="8" height="2" rx="1" transform="matrix(1 0 0 -1 6 8)" fill="currentColor" />
      <path
        d="M10 6C9.44772 6 9 6.44772 9 7L9 14C9 14.5523 9.44772 15 10 15C10.5523 15 11 14.5523 11 14L11 7C11 6.44772 10.5523 6 10 6Z"
        fill="currentColor"
      />
    </svg>
  );
}
