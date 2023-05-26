import { useOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";

export function EnvironmentIcon({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  let color = "bg-devEnv-500";
  if (slug === "live") {
    color = "bg-liveEnv-500";
  }
  return (
    <span
      className={cn(
        "block h-[0.35rem] w-[0.35rem] rounded-full",
        color,
        className
      )}
    />
  );
}

export default function Page() {
  const organization = useOrganization();

  return <div>Environments</div>;
}
