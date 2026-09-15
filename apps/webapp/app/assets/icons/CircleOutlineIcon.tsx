/** Hollow circle. Paired with {@link CircleFilledIcon} by the Black and White
 *  theme options, which show the active theme's background through the ring. */
export function CircleOutlineIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
