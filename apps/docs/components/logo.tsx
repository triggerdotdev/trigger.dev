import { basePath } from "@/lib/base-path";

// The Trigger.dev logo from the brand kit (https://trigger.dev/brand), in brand/ (copied to public/brand by the prebuild):
// the charcoal lockup on light, the gradient lockup on dark.
const RATIO = 750 / 130;

export function Logo({ className }: { className?: string }) {
  return (
    <>
      <img
        src={`${basePath}/brand/triggerdev-lockup--dark.svg`}
        alt="Trigger.dev"
        width={22 * RATIO}
        height={22}
        className={`dark:hidden ${className ?? ""}`}
      />
      <img
        src={`${basePath}/brand/triggerdev-lockup--light.svg`}
        alt="Trigger.dev"
        width={22 * RATIO}
        height={22}
        className={`hidden dark:block ${className ?? ""}`}
      />
    </>
  );
}
