import { oneAtATime } from "./trigger/concurrency";

export async function main() {
  // Trigger oneAtATime 5 times in parallel
  // await Promise.all(
  //   [1, 2, 3, 4, 5].map((i) =>
  //     oneAtATime.trigger({
  //       payload: { message: `This is a message from concurrencyUsage.ts: ${i}` },
  //     })
  //   )
  // );

  await Promise.all(
    [1, 2, 3, 4, 5].map((i) =>
      oneAtATime.trigger({
        payload: { message: `(concurrencyKey) This is a message from concurrencyUsage.ts: ${i}` },
        options: { concurrencyKey: `foobar-${i}` },
      })
    )
  );
}

main().then(console.log).catch(console.error);
