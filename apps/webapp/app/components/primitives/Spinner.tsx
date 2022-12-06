export function Spinner() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="animate-spin"
    >
      <rect
        x="2"
        y="2"
        width="16"
        height="16"
        rx="8"
        stroke="#BBF7D0"
        strokeWidth="3"
      />
      <path
        d="M10 18C5.58172 18 2 14.4183 2 10C2 5.58172 5.58172 2 10 2"
        stroke="#22C55E"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
