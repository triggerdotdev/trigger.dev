import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { TemplatesGrid } from "~/components/templates/TemplatesGrid";
import { TemplateListPresenter } from "~/presenters/templateListPresenter.server";

export const loader = async () => {
  const presenter = new TemplateListPresenter();

  return typedjson(await presenter.data());
};

export default function TemplateList() {
  const { templates } = useTypedLoaderData<typeof loader>();

  return <TemplatesGrid templates={templates} openInNewPage={true} />;
}
