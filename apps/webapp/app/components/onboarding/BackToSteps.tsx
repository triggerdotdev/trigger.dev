import { Link } from "@remix-run/react";
import { TertiaryLink } from "../primitives/Buttons";
import { SubTitle } from "../primitives/text/SubTitle";
import { StepNumber } from "./StepNumber";

export function BackToStep1() {
  return (
    <>
      <SubTitle className="flex items-center">
        <StepNumber />
        <Link to=".." className="transition hover:text-slate-300">
          I'll host the workflow myself
        </Link>
      </SubTitle>
      <TertiaryLink to="..">Change answer</TertiaryLink>
    </>
  );
}

export function BackToStep2() {
  return (
    <>
      <SubTitle className="flex items-center">
        <StepNumber />
        <Link to="../step2" className="transition hover:text-slate-300">
          I'll start with a template
        </Link>
      </SubTitle>
      <TertiaryLink to="../step2">Change answer</TertiaryLink>
    </>
  );
}
