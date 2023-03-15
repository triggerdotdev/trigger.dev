import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { TemplateOverview } from "~/components/templates/TemplateOverview";
import { TemplatePresenter } from "~/presenters/templatePresenter.server";

export async function loader({ params }: LoaderArgs) {
  const { slug } = params;
  invariant(typeof slug === "string", "Slug must be a string");

  const presenter = new TemplatePresenter();

  return typedjson(await presenter.data({ slug }));
}

export default function TemplateSlugPage() {
  const { template } = useTypedLoaderData<typeof loader>();

  if (!template) {
    return <div>Template not found</div>;
  }

  return (
    <div className="w-full overflow-y-auto bg-slate-850">
      <div className="mx-auto mt-10 max-w-[1188px]">
        <Link
          to="/templates"
          className="mb-4 ml-4 flex items-center justify-start gap-2 text-sm text-slate-500 transition hover:text-slate-300 lg:-ml-1"
        >
          <ArrowLeftIcon className="h-3 w-3" />
          Choose a different Template
        </Link>
        <TemplateOverview template={template} className="-ml-4" />
      </div>
    </div>
  );
}
