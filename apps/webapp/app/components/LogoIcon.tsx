export function LogoIcon({ className }: { className?: string }) {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect width="32" height="32" rx="8" fill="#2E7D32" />
      <path
        d="M16 6L24 24H8L16 6Z"
        fill="white"
        fillOpacity="0.9"
      />
      <circle cx="16" cy="20" r="2" fill="#2E7D32" />
    </svg>
  );
}
