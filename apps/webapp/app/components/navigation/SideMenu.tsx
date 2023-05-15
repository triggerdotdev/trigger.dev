import invariant from "tiny-invariant";
import { useCurrentProject } from "~/hooks/useProject";

export function SideMenuContainer({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full w-full">{children}</div>;
}

export function ProjectSideMenu() {
  const project = useCurrentProject();
  invariant(project, "Project must be defined");

  return <>{project.name}</>;
}
