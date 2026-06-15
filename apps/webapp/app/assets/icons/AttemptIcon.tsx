export function AttemptIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        width="6"
        height="2"
        rx="1"
        transform="matrix(1 0 0 -1 9 15)"
        fill="currentColor"
      />
      <rect
        width="2.48444"
        height="2"
        rx="1"
        transform="matrix(1 0 0 -1 10.8042 9)"
        fill="currentColor"
      />
      <path
        d="M12.125 7.06332C11.6119 6.88324 11.0493 7.14809 10.8613 7.65823L7.70722 16.2127C7.52479 16.7075 7.77801 17.2565 8.27281 17.4389C8.7645 17.6202 9.31041 17.3713 9.49607 16.8813L12.7262 8.35528C12.9243 7.83221 12.6528 7.24858 12.125 7.06332Z"
        fill="currentColor"
      />
      <path
        d="M11.9626 7.06332C12.4757 6.88324 13.0383 7.14809 13.2264 7.65823L16.3804 16.2127C16.5628 16.7075 16.3096 17.2565 15.8148 17.4389C15.3231 17.6202 14.7772 17.3713 14.5915 16.8813L11.3614 8.35528C11.1633 7.83221 11.4349 7.24858 11.9626 7.06332Z"
        fill="currentColor"
      />
    </svg>
  );
}
