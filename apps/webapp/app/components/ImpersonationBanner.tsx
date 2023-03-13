import { Form } from "@remix-run/react";
import { TertiaryButton } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";

export function ImpersonationBanner({
  impersonationId,
}: {
  impersonationId: string;
}) {
  return (
    <div className="grid h-8 grid-cols-3 items-center bg-gradient-to-r from-amber-500 via-amber-400 to-amber-500 px-4 text-center">
      <span></span>
      <Body size="small" className="text-slate-800">
        You are impersonating{" "}
        <span className="font-semibold">{impersonationId}</span>
      </Body>
      <Form
        action="/resources/impersonation"
        method="delete"
        reloadDocument
        className="justify-self-end"
      >
        <TertiaryButton
          type="submit"
          className="!text-slate-700 transition hover:!text-slate-900"
        >
          Stop impersonating
        </TertiaryButton>
      </Form>
    </div>
  );
}
