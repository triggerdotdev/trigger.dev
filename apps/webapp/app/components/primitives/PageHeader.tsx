import { Link } from "@remix-run/react";
import { Header1 } from "./Headers";
import { BreadcrumbIcon } from "./BreadcrumbIcon";
import { ChevronLeftIcon } from "@heroicons/react/24/solid";
import { Paragraph } from "./Paragraph";

type WithChildren = {
  children: React.ReactNode;
};

export function PageHeader({ children }: WithChildren) {
  return <div className="pb-4">{children}</div>;
}

export function PageTitleRow({ children }: WithChildren) {
  return <div className="flex items-center justify-between">{children}</div>;
}

type PageTitleProps = {
  title: string;
  backButton?: {
    to: string;
    text: string;
  };
};

export function PageTitle({ title, backButton }: PageTitleProps) {
  return (
    <div className="flex items-center gap-2">
      {backButton && (
        <div className="flex items-center gap-2">
          <Link
            to={backButton.to}
            className="flex items-center gap-1 text-slate-400 transition hover:text-white"
          >
            <ChevronLeftIcon className="h-6" />
            <Header1 variant="dimmed" className="transition hover:text-white">
              {backButton.text}
            </Header1>
          </Link>
          <BreadcrumbIcon className="h-6" />
        </div>
      )}
      <Header1>{title}</Header1>
    </div>
  );
}

export function PageButtons({ children }: WithChildren) {
  return <div className="flex gap-2">{children}</div>;
}

export function PageDescription({ children }: WithChildren) {
  return (
    <Paragraph variant="small" className="mt-2 mb-0">
      {children}
    </Paragraph>
  );
}
