import { Link } from "@remix-run/react";
import { TertiaryLink } from "../primitives/Buttons";
import { SubTitle } from "../primitives/text/SubTitle";
import { StepNumber } from "./StepNumber";

export function BackToStep1() {
  return (
    <>
      <SubTitle className="flex items-center">
        <StepNumber complete />
        <Link to=".." className="transition hover:text-slate-300">
          I'll host the workflow myself
        </Link>
      </SubTitle>
      <TertiaryLink to="..">Change answer</TertiaryLink>
    </>
  );
}

export function BackToStep2({ text }: { text: string }) {
  return (
    <>
      <SubTitle className="flex items-center">
        <StepNumber complete />
        <Link to="../step2" className="transition hover:text-slate-300">
          {text}
        </Link>
      </SubTitle>
      <TertiaryLink to="../step2">Change answer</TertiaryLink>
    </>
  );
}
