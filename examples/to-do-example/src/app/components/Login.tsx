import { ArrowRightIcon, EnvelopeIcon } from "@heroicons/react/20/solid";
import { Paragraph } from "./Paragraph";
import { Button } from "./Button";

<ArrowRightIcon className="group-hover:translate-x-2 h-6 w-6 transition" />;

export function Login() {
  return (
    <div className="flex flex-col w-full gap-y-4">
      <Paragraph variant="base" removeBottomPadding>
        Login to use all the Trigger.dev features
      </Paragraph>
      <Button
        buttonText={"Login with magic link"}
        buttonVariant={"primary"}
        buttonSize={"medium"}
        iconLeft={<EnvelopeIcon className="h-8 w-8" />}
        iconRight={
          <ArrowRightIcon className="group-hover:translate-x-2 transition h-8 w-8" />
        }
      />
      <Paragraph variant="small" className="text-slate-600" removeBottomPadding>
        We need this to save your to do list and so you can use your connected
        accounts.
      </Paragraph>
    </div>
  );
}
