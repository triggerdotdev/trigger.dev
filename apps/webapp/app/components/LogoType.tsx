export function LogoType({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 520 80"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="logoGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#2E7D32" />
          <stop offset="100%" stopColor="#43A047" />
        </linearGradient>
      </defs>
      {/* Icon */}
      <rect x="0" y="8" width="64" height="64" rx="14" fill="url(#logoGradient)" />
      <path d="M32 20L46 56H18L32 20Z" fill="white" fillOpacity="0.9" />
      <circle cx="32" cy="48" r="3.5" fill="#2E7D32" />
      {/* Text */}
      <text
        x="80"
        y="55"
        fontFamily="Geist Variable, Inter, Helvetica Neue, sans-serif"
        fontSize="42"
        fontWeight="600"
        letterSpacing="-0.02em"
        fill="currentColor"
      >
        AirTrigger
      </text>
    </svg>
  );
}
