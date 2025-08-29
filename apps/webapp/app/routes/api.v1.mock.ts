import { ActionFunctionArgs } from "@remix-run/server-runtime";

export async function action({ request }: ActionFunctionArgs) {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }

  return new Response(
    JSON.stringify({
      data: {
        id: "123",
        type: "mock",
        attributes: {
          name: "Mock",
        },
      },
    }),
    { status: 200 }
  );
}
