import { Text, useApp, useStdin } from "ink";
import React, { useEffect } from "react";
import { withErrorBoundary } from "react-error-boundary";
import { DevSessionOptions, startDevSession } from "./devSession.js";

export type DevProps = DevSessionOptions;

export function DevImplementation(props: DevProps): JSX.Element {
  // only load the UI if we're running in a supported environment
  const { isRawModeSupported } = useStdin();
  const { exit } = useApp();

  const onErr = (error: Error) => {
    exit(error);
  };

  return props.showInteractiveDevSession ?? isRawModeSupported ? (
    <InteractiveDevSession {...props} onErr={onErr} />
  ) : (
    <DevSession {...props} onErr={onErr} />
  );
}

type DevSessionProps = DevProps & {
  onErr: (error: Error) => void;
};

function InteractiveDevSession(props: DevSessionProps) {
  return (
    <>
      <DevSession {...props} />
    </>
  );
}

function DevSession(props: DevSessionProps) {
  const dev = useDev(props);

  return <></>;
}

function useDev(props: DevSessionProps) {
  useEffect(() => {
    let watcher: Awaited<ReturnType<typeof startDevSession>> | undefined;

    async function run() {
      watcher = await startDevSession(props);
    }

    run().catch((error) => {
      // If esbuild fails on first run, we want to quit the process
      // since we can't recover from here
      // related: https://github.com/evanw/esbuild/issues/1037
      props.onErr(error);
    });

    return () => {
      watcher?.stop();
    };
  }, [
    props.client,
    props.initialMode,
    props.name,
    props.rawArgs,
    props.rawConfig,
    props.showInteractiveDevSession,
  ]);
}

function ErrorFallback(props: { error: Error }) {
  const { exit } = useApp();
  useEffect(() => exit(props.error));
  return (
    <>
      <Text>Something went wrong:</Text>
      <Text>{props.error.stack}</Text>
    </>
  );
}

export default withErrorBoundary(DevImplementation, {
  FallbackComponent: ErrorFallback,
}) as React.ComponentType<DevProps>;
