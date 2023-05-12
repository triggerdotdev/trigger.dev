import { Form } from "@remix-run/react";
import { Paragraph } from "./primitives/Paragraph";
import { Button } from "./primitives/Buttons";

export function ImpersonationBanner({
  impersonationId,
}: {
  impersonationId: string;
}) {
  return (
    <div className="grid h-8 grid-cols-3 items-center bg-gradient-to-r from-amber-500 via-amber-400 to-amber-500 px-4 text-center">
      <span></span>
      <Paragraph variant="small">
        You are impersonating{" "}
        <span className="font-semibold">{impersonationId}</span>
      </Paragraph>
      <Form
        action="/resources/impersonation"
        method="delete"
        reloadDocument
        className="justify-self-end"
      >
        <Button
          type="submit"
          className="!text-slate-700 transition hover:!text-slate-900"
          children="Stop impersonating"
          size="small"
          theme="secondary"
        />
      </Form>
    </div>
  );
}
