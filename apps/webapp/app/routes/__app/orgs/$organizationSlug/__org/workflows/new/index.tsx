import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { TemplatesGrid } from "~/components/templates/TemplatesGrid";
import { TemplateListPresenter } from "~/presenters/templateListPresenter.server";

export const loader = async () => {
  const presenter = new TemplateListPresenter();
  return typedjson(await presenter.data());
};

export default function NewWorkflowStep1Page() {
  const { templates } = useTypedLoaderData<typeof loader>();
  return (
    <div className="max-w-xl">
      <SubTitle>
        Install one of these Templates directly into your codebase
      </SubTitle>
      <TemplatesGrid templates={templates} openInNewPage={false} />
    </div>
  );
}
