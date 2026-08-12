/** Solid circle. Paired with {@link CircleOutlineIcon} by the Black and White
 *  theme options — the filled disc reads as the opposite of the active theme. */
export function CircleFilledIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="9" fill="currentColor" />
    </svg>
  );
}
