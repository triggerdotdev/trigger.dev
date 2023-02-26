import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Header2 } from "~/components/primitives/text/Headers";
import { TemplatesGrid } from "~/components/templates/TemplatesGrid";
import { TemplateListPresenter } from "~/presenters/templateListPresenter.server";

export const loader = async () => {
  const presenter = new TemplateListPresenter();

  return typedjson(await presenter.data());
};

export default function TemplateList() {
  const { templates } = useTypedLoaderData<typeof loader>();

  return (
    <div className="mx-auto mt-4 flex max-w-6xl flex-col lg:mt-6">
      <h1 className="mb-6 text-center font-title text-5xl font-semibold text-slate-200">
        Choose your Template
      </h1>
      <Header2 size="small" className="mb-16 text-center text-slate-400">
        Quickly get started with your workflow by using a pre-built template.
      </Header2>
      <TemplatesGrid templates={templates} openInNewPage={true} />
    </div>
  );
}
