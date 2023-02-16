import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
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
    <>
      <Link
        to="/templates"
        className="mb-4 flex w-max items-center justify-start gap-2 text-sm text-slate-500 transition hover:text-slate-300"
      >
        <ArrowLeftIcon className="h-3 w-3 " />
        Choose a different Template
      </Link>
      <TemplateOverview template={template} />
    </>
  );
}
