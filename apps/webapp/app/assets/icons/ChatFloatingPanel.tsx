export function ChatFloatingPanel({ className }: { className?: string }) {
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
        d="M19 5H5C3.89543 5 3 5.89543 3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V7C21 5.89543 20.1046 5 19 5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M17 10H15C14.4477 10 14 10.4477 14 11V15C14 15.5523 14.4477 16 15 16H17C17.5523 16 18 15.5523 18 15V11C18 10.4477 17.5523 10 17 10Z"
        fill="currentColor"
      />
    </svg>
  );
}
