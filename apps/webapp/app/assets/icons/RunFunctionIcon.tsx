export function RunFunctionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="2.5"
        stroke="currentColor"
        strokeOpacity="0.5"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12.0334 11.6638C12.0334 10.3784 13.0754 9.33638 14.3608 9.33638H15.5275V7.00305H14.3608C13.5122 7.00305 12.7166 7.22983 12.0312 7.6261V7.00305H9.70006V11.6638V12.046V17.5035H12.0334V11.6638Z"
        fill="currentColor"
      />
    </svg>
  );
}
