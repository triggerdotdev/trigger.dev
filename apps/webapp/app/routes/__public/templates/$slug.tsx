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

  return <TemplateOverview template={template} />;
}
