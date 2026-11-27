"use client";

import { useReaderProject } from "@/lib/reader";

/** In a figure, the signed-in reader's own project or organization name; the example name otherwise. */
export function ReaderText({
  field,
  children,
}: {
  field: "project" | "org" | "org-initials";
  children: string;
}) {
  const project = useReaderProject();
  if (!project) return children;
  if (field === "project") return project.name;
  return field === "org" ? project.orgTitle : project.orgTitle.slice(0, 2);
}
