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
      <rect x="11" y="2" width="2" height="20" rx="1" fill="currentColor" />
      <rect
        x="22"
        y="11"
        width="2"
        height="20"
        rx="1"
        transform="rotate(90 22 11)"
        fill="currentColor"
      />
      <rect
        x="5.63604"
        y="19.7782"
        width="2"
        height="20"
        rx="1"
        transform="rotate(-135 5.63604 19.7782)"
        fill="currentColor"
      />
      <rect
        x="19.7781"
        y="18.364"
        width="2"
        height="20"
        rx="1"
        transform="rotate(135 19.7781 18.364)"
        fill="currentColor"
      />
    </svg>
  );
}
