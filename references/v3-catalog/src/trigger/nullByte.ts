import { task } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";

export const nullByteCrash = task({
  id: "null-byte-parent",
  run: async (payload: any, { ctx }) => {
    const nullByteUnicode = "\u0000";

    await setTimeout(5000);

    await nullByteChild.triggerAndWait({
      message: `Null byte: ${nullByteUnicode}`,
    });
  },
});

export const nullByteChild = task({
  id: "null-byte-child",
  run: async (payload: any, { ctx }) => {},
});
