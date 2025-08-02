import { CodeBlock } from "~/components/code/CodeBlock";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import type { ErrorData } from "~/presenters/v3/DeploymentPresenter.server";

type DeploymentErrorProps = {
  errorData: ErrorData;
};

export function DeploymentError({ errorData }: DeploymentErrorProps) {
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-rose-500/50 p-3">
      <DeploymentErrorHeader title={errorData.name ?? "Error"} titleClassName="text-rose-500" />
      {errorData.message && <Callout variant="error">{errorData.message}</Callout>}
      {errorData.stack && (
        <CodeBlock
          showCopyButton={false}
          showLineNumbers={false}
          code={errorData.stack}
          maxLines={20}
          showTextWrapping
        />
      )}
      {errorData.stderr && (
        <>
          <DeploymentErrorHeader title="Error logs:" />
          <CodeBlock
            showCopyButton={false}
            showLineNumbers={false}
            code={errorData.stderr}
            maxLines={20}
            showTextWrapping
          />
        </>
      )}
    </div>
  );
}

function DeploymentErrorHeader({
  title,
  titleClassName,
}: {
  title: string;
  titleClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <Header2 className={titleClassName}>{title}</Header2>
    </div>
  );
}
