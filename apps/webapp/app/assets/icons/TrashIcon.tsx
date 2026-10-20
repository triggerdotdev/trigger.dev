export function TrashIcon({ className }: { className?: string }) {
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
        d="M17.9355 7L17.1777 19.125C17.1117 20.179 16.2377 21 15.1816 21H8.81836C7.76231 21 6.88826 20.179 6.82227 19.125L6.06445 7H17.9355Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect x="4" y="6" width="16" height="2" rx="1" fill="currentColor" />
      <rect
        x="11"
        y="10"
        width="7"
        height="2"
        rx="1"
        transform="rotate(90 11 10)"
        fill="currentColor"
      />
      <rect
        x="15"
        y="10"
        width="7"
        height="2"
        rx="1"
        transform="rotate(90 15 10)"
        fill="currentColor"
      />
      <path
        d="M15 7C15 5.34315 13.6569 4 12 4C10.3431 4 9 5.34315 9 7"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
