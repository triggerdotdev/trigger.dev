import { useFetcher } from "@remix-run/react";
import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { useEffect } from "react";
import invariant from "tiny-invariant";
import { CodeBlock } from "~/components/code/CodeBlock";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { type ApiExample } from "~/services/externalApis/apis.server";
import { requireUserId } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUserId(request);
  const url = new URL(request.url);
  const codeUrl = url.searchParams.get("url");
  invariant(typeof codeUrl === "string", "codeUrl is required");
  const decodedCodeUrl = decodeURIComponent(codeUrl);
  const response = await fetch(decodedCodeUrl);
  if (!response.ok) {
    throw new Error("Network response was not ok");
  }

  const code = await response.text();

  const hideCodeRegex = /(\n)?\/\/ hide-code[\s\S]*?\/\/ end-hide-code(\n)*/gm;
  const cleanedCode = code?.replace(hideCodeRegex, "\n");

  return json({
    code: cleanedCode,
  });
}

export function CodeExample({ example }: { example: ApiExample }) {
  const customerFetcher = useFetcher<typeof loader>();

  useEffect(() => {
    customerFetcher.load(`/resources/codeexample?url=${encodeURIComponent(example.codeUrl)}`);
  }, [example.codeUrl]);

  if (customerFetcher.state === "loading")
    return (
      <div className="flex h-96 w-full items-center justify-center gap-2 rounded-md border border-charcoal-800 font-mono">
        <Spinner />
        <Paragraph>Loading example code</Paragraph>
      </div>
    );

  return (
    customerFetcher.data && <CodeBlock code={customerFetcher.data.code ?? ""} className="mt-2" />
  );
}
