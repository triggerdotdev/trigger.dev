import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { WorkflowOnboarding } from "~/components/workflows/WorkflowOnboarding";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { TemplateListPresenter } from "~/presenters/templateListPresenter.server";

export const loader = async () => {
  const presenter = new TemplateListPresenter();
  return typedjson(await presenter.data());
};

export default function NewWorkflowStep1Page() {
  const { templates } = useTypedLoaderData<typeof loader>();
  const currentOrganization = useCurrentOrganization();
  const currentEnv = useDevEnvironment();

  if (currentOrganization === undefined) {
    return <></>;
  }

  if (currentEnv === undefined) {
    return <></>;
  }
  return (
    <div className="max-w-6xl">
      <WorkflowOnboarding templates={templates} apiKey={currentEnv.apiKey} />
    </div>
  );
}
