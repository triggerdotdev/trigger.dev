"use client";

import type { ComponentProps } from "react";
import { dashboardHref } from "@/lib/dashboard-link";
import { useReaderProject } from "@/lib/reader";

/** A link into the dashboard from the content: lands in the reader's picked project. */
export function DashboardAnchor({
  href,
  children,
  ...props
}: ComponentProps<"a"> & { href: string }) {
  const ref = useReaderProject()?.ref;
  return (
    <a {...props} href={dashboardHref(href, ref)}>
      {children}
    </a>
  );
}
