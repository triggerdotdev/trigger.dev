import { useFetcher } from "@remix-run/react";
import { LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { useEffect } from "react";
import { useQuery } from "react-query";
import invariant from "tiny-invariant";
import { CodeBlock } from "~/components/code/CodeBlock";
import { ApiExample } from "~/services/externalApis/apis.server";
import { requireUser } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const codeUrl = url.searchParams.get("url");
  invariant(typeof codeUrl === "string", "codeUrl is required");
  const decodedCodeUrl = decodeURIComponent(codeUrl);
  const response = await fetch(decodedCodeUrl);
  if (!response.ok) {
    throw new Error("Network response was not ok");
  }

  const code = await response.text();

  return json({
    code,
  });
}

export function CodeExample({ example }: { example: ApiExample }) {
  const customerFetcher = useFetcher<typeof loader>();

  useEffect(() => {
    customerFetcher.load(`/resources/codeexample?url=${encodeURIComponent(example.codeUrl)}`);
  }, [example.codeUrl]);

  if (customerFetcher.state === "loading") return "Loading...";

  return customerFetcher.data && <CodeBlock code={customerFetcher.data?.code} className="mb-4" />;
}
