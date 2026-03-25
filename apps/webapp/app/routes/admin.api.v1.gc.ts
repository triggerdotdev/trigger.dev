import { type DataFunctionArgs } from "@remix-run/node";
import { PerformanceObserver } from "node:perf_hooks";
import { runInNewContext } from "node:vm";
import v8 from "v8";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

async function waitTillGcFinishes() {
  let resolver: (value: PerformanceEntry) => void;
  let rejector: (reason?: any) => void;

  const promise = new Promise<PerformanceEntry>((resolve, reject) => {
    resolver = resolve;
    rejector = reject;
  });

  const obs = new PerformanceObserver((list) => {
    const entry = list.getEntries()[0];

    if (entry.name === "gc") {
      resolver(entry);
    }
  });

  obs.observe({ entryTypes: ["gc"] });

  v8.setFlagsFromString("--expose-gc");
  const gc = global.gc ?? runInNewContext("gc");

  gc();

  // disable expose-gc
  v8.setFlagsFromString("--noexpose-gc");

  return promise;
}

export async function loader({ request }: DataFunctionArgs) {
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    throw new Response("You must be an admin to perform this action", { status: 403 });
  }

  const user = await prisma.user.findFirst({
    where: {
      id: authenticationResult.userId,
    },
  });

  if (!user?.admin) {
    throw new Response("You must be an admin to perform this action", { status: 403 });
  }

  const entry = await waitTillGcFinishes();

  return new Response(JSON.stringify(entry), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
