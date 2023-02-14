import { Link } from "@remix-run/react";
import classNames from "classnames";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { BackToStep1, BackToStep2 } from "~/components/onboarding/BackToSteps";
import { onboarding } from "~/components/onboarding/classNames";
import { StepNumber } from "~/components/onboarding/StepNumber";
import { TertiaryLink } from "~/components/primitives/Buttons";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { TemplatesGrid } from "~/components/templates/TemplatesGrid";
import { TemplateListPresenter } from "~/presenters/templateListPresenter.server";

export const loader = async () => {
  const presenter = new TemplateListPresenter();

  return typedjson(await presenter.data());
};

export default function Step3NewRepo1() {
  const { templates } = useTypedLoaderData<typeof loader>();

  return (
    <div className={classNames(onboarding.maxWidth)}>
      <div className="flex items-center justify-between">
        <BackToStep1 />
      </div>
      <div className="flex items-center justify-between">
        <BackToStep2 />
      </div>
      <div className="mb-6">
        <SubTitle className="flex items-center">
          <StepNumber active stepNumber="3" />
          Which template would you like to use?
        </SubTitle>
        <TemplatesGrid templates={templates} />
      </div>
    </div>
  );
}
