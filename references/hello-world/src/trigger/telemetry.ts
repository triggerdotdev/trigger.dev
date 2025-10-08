import { logger, task } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";

export const simpleSuccessTask = task({
  id: "otel/simple-success-task",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello log 1", { ctx });
    logger.info("Hello info 1");
    logger.warn("Hello warn 1");
    logger.error("Hello error 1");

    await setTimeout(15000);

    logger.log("Hello log 2");
    logger.info("Hello info 2");
    logger.warn("Hello warn 2");
    logger.error("Hello error 2");

    return { message: "Hello, world!" };
  },
});

export const simpleFailureTask = task({
  id: "otel/simple-failure-task",
  retry: {
    maxAttempts: 1,
  },
  run: async (payload: any, { ctx }) => {
    await setTimeout(5000);

    throw new Error("Hello error");
  },
});

export const failureWithRetries = task({
  id: "otel/failure-with-retries",
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: any, { ctx }) => {
    await setTimeout(15000);

    throw new Error("Hello error");
  },
});

export const taskWithChildTasks = task({
  id: "otel/task-with-child-tasks",
  run: async (payload: any, { ctx }) => {
    await simpleSuccessTask.triggerAndWait({});
  },
});

export const taskWithBadLogString = task({
  id: "otel/task-with-bad-log-string",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello, world!", {
      myString: "👋🏽 I’m Shelby, of Defense.\n\n𝐋𝐞𝐭'𝐬 𝐛𝐮𝐢𝐥𝐝 𝐭𝐡𝐞 \ud835",
    });

    logger.log("Hello, world!", {
      myString:
        "👋🏽 I’m Shelby, an award-winning people leader, an award-winning people leader, an award-winning people leader, an award-winning people leader, an award-winning people leader, an award-winning people leader, an award-winning people leader, an award-winning people leader, an award-winning people leader, an award-winning people leader, an award-winning people leader, MIT-trained mathematician, and AI researcher, engineer, and speaker.\n\nI drive clarity, vision, and execution at the frontier of AI, empowering teams to build breakthrough technologies with real-world, enterprise impact. 💥\n\n🔹 35+ influential AI research publications across AI agents, LLMs, SLMs, and ML (see 𝘗𝘶𝘣𝘭𝘪𝘤𝘢𝘵𝘪𝘰𝘯𝘴 below)\n🔹 8+ years developing applied AI for Fortune 500 use cases\n🔹 10+ years hands-on engineering • 16+ years teaching & speaking with clarity\n🔹 Featured in VentureBeat, ZDNET, and more (see 𝘔𝘦𝘥𝘪𝘢 𝘊𝘰𝘷𝘦𝘳𝘢𝘨𝘦 below)\n🔹 30+ AI keynotes, talks, podcasts, and panels (see 𝘒𝘦𝘺𝘯𝘰𝘵𝘦𝘴 below)\n\nCurrently, I lead and manage a growing team of AI researchers and engineers at Salesforce. We push the boundaries of agentic AI, multi-agent systems, on-device AI, and efficient models.\n\nPreviously, I spent time in research andAI, and efficient models.\n\nPreviously, I spent time in research andAI, and efficient models.\n\nPreviously, I spent time in research andAI, and efficient models.\n\nPreviously, I spent time in research andAI, and efficient models.\n\nPreviously, I spent time in research andAI, and efficient models.\n\nPreviously, I spent time in research andAI, and efficient models.\n\nPreviously, I spent time in research andAI, and efficient models.\n\nPreviously, I spent time in research andAI, and efficient models.\n\nPreviously, I spent time in research and engineering at Intel, IBM Research, MITRE, and the Department of Defense.\n\n𝐋𝐞𝐭'𝐬 𝐛𝐮𝐢𝐥𝐝 𝐭𝐡𝐞 \ud835",
    });
  },
});

export const generateLogsParentTask = task({
  id: "otel/generate-logs-parent",
  run: async (payload: any) => {
    await generateLogsTask.triggerAndWait({});
    await generateLogsTask.triggerAndWait({});
    await generateLogsTask.triggerAndWait({});
    await generateLogsTask.triggerAndWait({});
    await generateLogsTask.triggerAndWait({});
    await generateLogsTask.triggerAndWait({});
    await generateLogsTask.triggerAndWait({});
    await generateLogsTask.triggerAndWait({});
    await generateLogsTask.triggerAndWait({});
    await generateLogsTask.triggerAndWait({});
    await generateLogsTask.triggerAndWait({});
    await generateLogsTask.triggerAndWait({});
  },
});

export const generateLogsTask = task({
  id: "otel/generate-logs",
  run: async (payload: any, { ctx }) => {
    await generateLogs(101);

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 1", async () => {
      await generateLogs(101);
    });

    await logger.trace("span 2", async () => {
      await generateLogs(101);

      await logger.trace("span 2.1", async () => {
        await generateLogs(101);

        await logger.trace("span 2.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 2.1.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });

    await logger.trace("span 3", async () => {
      await generateLogs(101);

      await logger.trace("span 3.1", async () => {
        await generateLogs(101);

        await logger.trace("span 3.1.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.1.1.1", async () => {
            await generateLogs(101);
          });
        });

        await logger.trace("span 3.2.1", async () => {
          await generateLogs(101);

          await logger.trace("span 3.2.1.1", async () => {
            await generateLogs(101);
          });
        });
      });
    });
  },
});

async function generateLogs(count: number) {
  await Promise.all(
    Array.from({ length: count }).map(async () => {
      await setTimeout(1000);

      const logMessage = generateRandomLogMessage();

      switch (logMessage.level) {
        case "DEBUG": {
          logger.debug(logMessage.message, { ...logMessage.metadata, ...generateRandomObject() });
          break;
        }
        case "INFO": {
          logger.info(logMessage.message, { ...logMessage.metadata, ...generateRandomObject() });
          break;
        }
        case "WARN": {
          logger.warn(logMessage.message, { ...logMessage.metadata, ...generateRandomObject() });
          break;
        }
        case "FATAL":
        case "ERROR": {
          logger.error(logMessage.message, { ...logMessage.metadata, ...generateRandomObject() });
          break;
        }
      }
    })
  );
}

type RandomValue = string | number | boolean | null | RandomObject | RandomValue[];

interface RandomObject {
  [key: string]: RandomValue;
}

function generateRandomObject(depth: number = 3, maxKeys: number = 8): RandomObject {
  const obj: RandomObject = {};
  const numKeys = Math.floor(Math.random() * maxKeys) + 1;

  for (let i = 0; i < numKeys; i++) {
    const key = generateRandomKey();
    obj[key] = generateRandomValue(depth);
  }

  return obj;
}

function generateRandomValue(depth: number): RandomValue {
  if (depth <= 0) {
    return generatePrimitiveValue();
  }

  const valueTypes = ["primitive", "object", "array"];
  const weights = depth > 1 ? [0.6, 0.2, 0.2] : [0.8, 0.1, 0.1];
  const selectedType = weightedRandomChoice(valueTypes, weights);

  switch (selectedType) {
    case "primitive":
      return generatePrimitiveValue();
    case "object":
      return generateRandomObject(depth - 1, 5);
    case "array":
      return generateRandomArray(depth - 1);
    default:
      return generatePrimitiveValue();
  }
}

function generatePrimitiveValue(): string | number | boolean | null {
  const primitiveTypes = ["string", "number", "boolean", "null"];
  const type = primitiveTypes[Math.floor(Math.random() * primitiveTypes.length)];

  switch (type) {
    case "string":
      return generateRandomString();
    case "number":
      return generateRandomNumber();
    case "boolean":
      return Math.random() > 0.5;
    case "null":
      return null;
    default:
      return generateRandomString();
  }
}

function generateArrayOfPrimitiveValues(length: number): RandomValue[] {
  const primitiveTypes = ["string", "number", "boolean", "null"];
  const type = primitiveTypes[Math.floor(Math.random() * primitiveTypes.length)];

  switch (type) {
    case "string":
      return Array.from({ length }, () => generateRandomString());
    case "number":
      return Array.from({ length }, () => generateRandomNumber());
    case "boolean":
      return Array.from({ length }, () => Math.random() > 0.5);
    case "null":
      return Array.from({ length }, () => null);
    default:
      return Array.from({ length }, () => generateRandomString());
  }
}

function generateRandomString(): string {
  const stringTypes = [
    "name",
    "email",
    "city",
    "company",
    "product",
    "description",
    "color",
    "status",
    "category",
    "id",
    "url",
    "phone",
  ];

  const type = stringTypes[Math.floor(Math.random() * stringTypes.length)];

  const samples = {
    name: ["John Smith", "Sarah Johnson", "Michael Brown", "Emma Wilson", "David Lee"],
    email: ["user@example.com", "admin@company.org", "contact@business.net", "info@service.co.uk"],
    city: ["London", "Manchester", "Birmingham", "Edinburgh", "Cardiff", "Belfast"],
    company: [
      "TechCorp Ltd",
      "Global Solutions",
      "Innovation Hub",
      "Digital Dynamics",
      "Future Systems",
    ],
    product: ["Wireless Headphones", "Smart Watch", "Laptop Stand", "Coffee Maker", "Desk Lamp"],
    description: [
      "High-quality product with excellent features",
      "Reliable and efficient solution",
      "Modern design meets functionality",
    ],
    color: ["red", "blue", "green", "yellow", "purple", "orange", "black", "white"],
    status: ["active", "inactive", "pending", "completed", "cancelled", "processing"],
    category: ["electronics", "clothing", "books", "home", "sports", "automotive"],
    id: () => `${Math.random().toString(36).substr(2, 9)}`,
    url: ["https://example.com", "https://api.service.com/v1", "https://docs.platform.org"],
    phone: ["+44 20 7123 4567", "+44 161 234 5678", "+44 121 345 6789"],
  };

  const sampleArray = samples[type as keyof typeof samples];
  if (typeof sampleArray === "function") {
    return sampleArray();
  }
  return sampleArray[Math.floor(Math.random() * sampleArray.length)];
}

function generateRandomNumber(): number {
  const numberTypes = ["integer", "decimal", "large", "small"];
  const type = numberTypes[Math.floor(Math.random() * numberTypes.length)];

  switch (type) {
    case "integer":
      return Math.floor(Math.random() * 1000);
    case "decimal":
      return Math.round(Math.random() * 100 * 100) / 100;
    case "large":
      return Math.floor(Math.random() * 1000000);
    case "small":
      return Math.floor(Math.random() * 10);
    default:
      return Math.floor(Math.random() * 100);
  }
}

function generateRandomKey(): string {
  const commonKeys = [
    "id",
    "name",
    "email",
    "age",
    "address",
    "phone",
    "company",
    "title",
    "description",
    "price",
    "quantity",
    "status",
    "createdAt",
    "updatedAt",
    "isActive",
    "category",
    "tags",
    "metadata",
    "config",
    "settings",
    "userId",
    "productId",
    "orderId",
    "customerId",
    "location",
    "type",
    "value",
    "label",
    "color",
    "size",
    "weight",
    "dimensions",
    "features",
  ];

  return commonKeys[Math.floor(Math.random() * commonKeys.length)];
}

function generateRandomArray(depth: number): RandomValue[] {
  const arrayLength = Math.floor(Math.random() * 5) + 1;

  return generateArrayOfPrimitiveValues(arrayLength);
}

function weightedRandomChoice<T>(choices: T[], weights: number[]): T {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let random = Math.random() * totalWeight;

  for (let i = 0; i < choices.length; i++) {
    random -= weights[i];
    if (random <= 0) {
      return choices[i];
    }
  }

  return choices[choices.length - 1];
}

interface LogMessage {
  timestamp: string;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
  component: string;
  message: string;
  metadata?: Record<string, any>;
}

function generateRandomLogMessage(includeMetadata: boolean = true): LogMessage {
  const level = generateLogLevel();
  const component = generateComponent();
  const message = generateMessage(level, component);
  const timestamp = generateTimestamp();

  const logMessage: LogMessage = {
    timestamp,
    level,
    component,
    message,
  };

  if (includeMetadata && Math.random() > 0.3) {
    logMessage.metadata = generateMetadata(level);
  }

  return logMessage;
}

function generateLogLevel(): LogMessage["level"] {
  const levels: LogMessage["level"][] = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"];
  const weights = [0.3, 0.4, 0.15, 0.13, 0.02]; // INFO and DEBUG most common

  return weightedRandomChoice(levels, weights);
}

function generateComponent(): string {
  const components = [
    "AuthService",
    "DatabaseManager",
    "UserController",
    "PaymentProcessor",
    "EmailService",
    "CacheManager",
    "FileUploader",
    "APIGateway",
    "SecurityManager",
    "NotificationService",
    "OrderService",
    "ProductCatalog",
    "SessionManager",
    "ConfigLoader",
    "MetricsCollector",
    "HealthChecker",
    "MessageQueue",
    "SearchEngine",
    "ReportGenerator",
    "BackupService",
    "LoadBalancer",
    "RateLimiter",
    "ValidationService",
    "AuditLogger",
  ];

  return components[Math.floor(Math.random() * components.length)];
}

function generateMessage(level: LogMessage["level"], component: string): string {
  const messageTemplates = {
    DEBUG: [
      `Executing method ${generateMethodName()} with parameters: ${generateParameters()}`,
      `Cache hit for key: ${generateCacheKey()}`,
      `Processing request with ID: ${generateId()}`,
      `Database query executed in ${generateDuration()}ms`,
      `Validating input data for ${generateEntityName()}`,
      `Loading configuration from ${generateFilePath()}`,
      `Initializing connection pool with ${generateNumber(5, 20)} connections`,
      `Parsing JSON payload of size ${generateFileSize()}`,
      `Applying business rule: ${generateBusinessRule()}`,
    ],
    INFO: [
      `User ${generateUsername()} successfully logged in from ${generateIPAddress()}`,
      `Order ${generateOrderId()} created successfully for customer ${generateCustomerId()}`,
      `Email sent to ${generateEmail()} with subject: "${generateEmailSubject()}"`,
      `File ${generateFileName()} uploaded successfully (${generateFileSize()})`,
      `Payment of £${generatePrice()} processed for transaction ${generateTransactionId()}`,
      `New user registered: ${generateUsername()} (${generateEmail()})`,
      `Service started successfully on port ${generatePort()}`,
      `Database migration ${generateMigrationName()} completed successfully`,
      `Report ${generateReportName()} generated in ${generateDuration()}ms`,
      `Cache cleared for namespace: ${generateNamespace()}`,
    ],
    WARN: [
      `High memory usage detected: ${generatePercentage()}% of available memory`,
      `Slow query detected: ${generateDuration()}ms execution time`,
      `Rate limit approaching for user ${generateUsername()}: ${generateNumber(80, 95)}% of limit`,
      `Deprecated API endpoint accessed: ${generateAPIEndpoint()}`,
      `Connection pool nearly exhausted: ${generateNumber(18, 20)}/20 connections in use`,
      `Large file upload detected: ${generateFileSize()} from ${generateIPAddress()}`,
      `Failed login attempt for user ${generateUsername()} from ${generateIPAddress()}`,
      `Queue size growing: ${generateNumber(500, 1000)} pending messages`,
      `SSL certificate expires in ${generateNumber(1, 30)} days`,
      `Disk space low: ${generatePercentage()}% full on ${generateDiskPath()}`,
    ],
    ERROR: [
      `Failed to connect to database: ${generateErrorMessage()}`,
      `Payment processing failed for transaction ${generateTransactionId()}: ${generatePaymentError()}`,
      `Email delivery failed to ${generateEmail()}: ${generateEmailError()}`,
      `File upload failed: ${generateFileError()}`,
      `Authentication failed for user ${generateUsername()}: ${generateAuthError()}`,
      `API request to ${generateAPIEndpoint()} failed: ${generateHTTPError()}`,
      `Database query failed: ${generateSQLError()}`,
      `Service unavailable: ${generateServiceError()}`,
      `Configuration error: ${generateConfigError()}`,
      `Validation failed for ${generateEntityName()}: ${generateValidationError()}`,
    ],
    FATAL: [
      `Database connection pool exhausted, shutting down service`,
      `Out of memory error: Unable to allocate ${generateFileSize()}`,
      `Critical security breach detected from ${generateIPAddress()}`,
      `System disk full: Unable to write logs or process requests`,
      `Service dependency ${generateServiceName()} is completely unavailable`,
      `Unhandled exception caused service crash: ${generateCriticalError()}`,
      `Configuration file corrupted: Unable to start service`,
      `License validation failed: Service cannot continue`,
      `Critical data corruption detected in ${generateTableName()}`,
      `Network interface failure: All connections lost`,
    ],
  };

  const templates = messageTemplates[level];
  return templates[Math.floor(Math.random() * templates.length)];
}

function generateTimestamp(): string {
  const now = new Date();
  const randomOffset = Math.floor(Math.random() * 86400000); // Random time within last 24 hours
  const timestamp = new Date(now.getTime() - randomOffset);
  return timestamp.toISOString();
}

function generateMetadata(level: LogMessage["level"]): Record<string, any> {
  const baseMetadata: Record<string, any> = {
    requestId: generateId(),
    userId: Math.random() > 0.3 ? generateUserId() : null,
    sessionId: generateSessionId(),
    userAgent: generateUserAgent(),
    ipAddress: generateIPAddress(),
  };

  // Add level-specific metadata
  switch (level) {
    case "ERROR":
    case "FATAL":
      baseMetadata.stackTrace = generateStackTrace();
      baseMetadata.errorCode = generateErrorCode();
      break;
    case "WARN":
      baseMetadata.threshold = generateNumber(70, 95);
      baseMetadata.currentValue = generateNumber(75, 100);
      break;
    case "INFO":
      baseMetadata.duration = generateDuration();
      baseMetadata.statusCode = 200;
      break;
  }

  return baseMetadata;
}

// Helper functions for generating realistic data
function generateMethodName(): string {
  const prefixes = ["get", "set", "create", "update", "delete", "process", "validate", "calculate"];
  const suffixes = ["User", "Order", "Payment", "Data", "Config", "Report", "Session", "Token"];
  return `${prefixes[Math.floor(Math.random() * prefixes.length)]}${
    suffixes[Math.floor(Math.random() * suffixes.length)]
  }`;
}

function generateParameters(): string {
  const params = [];
  const numParams = Math.floor(Math.random() * 3) + 1;
  for (let i = 0; i < numParams; i++) {
    params.push(
      `param${i + 1}=${Math.random() > 0.5 ? `"${generateId()}"` : generateNumber(1, 1000)}`
    );
  }
  return `{${params.join(", ")}}`;
}

function generateId(): string {
  return Math.random().toString(36).substr(2, 12);
}

function generateUserId(): string {
  return `user_${Math.random().toString(36).substr(2, 8)}`;
}

function generateSessionId(): string {
  return `sess_${Math.random().toString(36).substr(2, 16)}`;
}

function generateOrderId(): string {
  return `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")}`;
}

function generateTransactionId(): string {
  return `TXN${Math.random().toString(36).substr(2, 10).toUpperCase()}`;
}

function generateCustomerId(): string {
  return `CUST${Math.floor(Math.random() * 100000)
    .toString()
    .padStart(5, "0")}`;
}

function generateUsername(): string {
  const usernames = [
    "john.smith",
    "sarah.jones",
    "mike.brown",
    "emma.wilson",
    "david.lee",
    "admin",
    "guest",
    "testuser",
  ];
  return usernames[Math.floor(Math.random() * usernames.length)];
}

function generateEmail(): string {
  const domains = ["example.com", "company.org", "business.co.uk", "service.net"];
  const username = generateUsername().replace(".", "");
  return `${username}@${domains[Math.floor(Math.random() * domains.length)]}`;
}

function generateIPAddress(): string {
  return `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(
    Math.random() * 256
  )}.${Math.floor(Math.random() * 256)}`;
}

function generateDuration(): number {
  return Math.floor(Math.random() * 5000) + 10;
}

function generateNumber(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generatePercentage(): number {
  return Math.floor(Math.random() * 100) + 1;
}

function generateFileSize(): string {
  const size = Math.floor(Math.random() * 1000) + 1;
  const units = ["KB", "MB", "GB"];
  const unit = units[Math.floor(Math.random() * units.length)];
  return `${size}${unit}`;
}

function generateFileName(): string {
  const names = ["document", "report", "image", "data", "config", "backup"];
  const extensions = [".pdf", ".xlsx", ".jpg", ".json", ".xml", ".zip"];
  return `${names[Math.floor(Math.random() * names.length)]}${Math.floor(Math.random() * 1000)}${
    extensions[Math.floor(Math.random() * extensions.length)]
  }`;
}

function generatePrice(): string {
  return (Math.random() * 1000 + 10).toFixed(2);
}

function generatePort(): number {
  return Math.floor(Math.random() * 9000) + 1000;
}

function generateCacheKey(): string {
  return `cache:${generateEntityName()}:${generateId()}`;
}

function generateEntityName(): string {
  const entities = ["user", "order", "product", "payment", "session", "config", "report"];
  return entities[Math.floor(Math.random() * entities.length)];
}

function generateAPIEndpoint(): string {
  const versions = ["v1", "v2", "v3"];
  const resources = ["users", "orders", "products", "payments", "reports"];
  return `/api/${versions[Math.floor(Math.random() * versions.length)]}/${
    resources[Math.floor(Math.random() * resources.length)]
  }`;
}

function generateErrorMessage(): string {
  const errors = [
    "Connection timeout after 30 seconds",
    "Invalid credentials provided",
    "Resource not found",
    "Permission denied",
    "Service temporarily unavailable",
    "Invalid request format",
    "Rate limit exceeded",
  ];
  return errors[Math.floor(Math.random() * errors.length)];
}

function generateUserAgent(): string {
  const agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "PostmanRuntime/7.29.2",
    "curl/7.68.0",
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

function generateStackTrace(): string {
  return `at ${generateMethodName()}(${generateFileName()}:${generateNumber(10, 500)})`;
}

function generateErrorCode(): string {
  const codes = ["E001", "E404", "E500", "E403", "E401", "E503", "E400"];
  return codes[Math.floor(Math.random() * codes.length)];
}

// Additional helper functions for specific error types
function generatePaymentError(): string {
  const errors = [
    "Insufficient funds",
    "Card expired",
    "Invalid card number",
    "Payment gateway timeout",
  ];
  return errors[Math.floor(Math.random() * errors.length)];
}

function generateEmailError(): string {
  const errors = [
    "SMTP server unavailable",
    "Invalid email address",
    "Message too large",
    "Recipient blocked",
  ];
  return errors[Math.floor(Math.random() * errors.length)];
}

function generateAuthError(): string {
  const errors = [
    "Invalid password",
    "Account locked",
    "Token expired",
    "Two-factor authentication required",
  ];
  return errors[Math.floor(Math.random() * errors.length)];
}

function generateHTTPError(): string {
  const codes = [400, 401, 403, 404, 500, 502, 503, 504];
  const code = codes[Math.floor(Math.random() * codes.length)];
  return `HTTP ${code}`;
}

function generateSQLError(): string {
  const errors = [
    "Syntax error",
    "Table does not exist",
    "Duplicate key violation",
    "Foreign key constraint",
  ];
  return errors[Math.floor(Math.random() * errors.length)];
}

function generateServiceError(): string {
  const services = ["Redis", "Elasticsearch", "RabbitMQ", "MongoDB"];
  return `${services[Math.floor(Math.random() * services.length)]} connection refused`;
}

function generateConfigError(): string {
  const errors = [
    "Missing required property",
    "Invalid configuration format",
    "Environment variable not set",
  ];
  return errors[Math.floor(Math.random() * errors.length)];
}

function generateValidationError(): string {
  const errors = [
    "Required field missing",
    "Invalid email format",
    "Value out of range",
    "Invalid date format",
  ];
  return errors[Math.floor(Math.random() * errors.length)];
}

function generateCriticalError(): string {
  const errors = [
    "NullPointerException",
    "OutOfMemoryError",
    "StackOverflowError",
    "SecurityException",
  ];
  return errors[Math.floor(Math.random() * errors.length)];
}

function generateServiceName(): string {
  const services = ["UserService", "PaymentGateway", "NotificationHub", "DatabaseCluster"];
  return services[Math.floor(Math.random() * services.length)];
}

function generateTableName(): string {
  const tables = ["users", "orders", "payments", "products", "sessions"];
  return tables[Math.floor(Math.random() * tables.length)];
}

function generateFilePath(): string {
  const paths = [
    "/etc/app/config.yml",
    "/var/log/app.log",
    "/opt/app/data.json",
    "/home/user/.env",
  ];
  return paths[Math.floor(Math.random() * paths.length)];
}

function generateDiskPath(): string {
  const paths = ["/var/log", "/tmp", "/home", "/opt"];
  return paths[Math.floor(Math.random() * paths.length)];
}

function generateMigrationName(): string {
  return `migration_${Date.now()}_${generateEntityName()}_table`;
}

function generateReportName(): string {
  const types = ["daily", "weekly", "monthly", "quarterly"];
  const subjects = ["sales", "users", "performance", "security"];
  return `${types[Math.floor(Math.random() * types.length)]}_${
    subjects[Math.floor(Math.random() * subjects.length)]
  }_report`;
}

function generateNamespace(): string {
  const namespaces = ["user:sessions", "product:catalog", "order:cache", "auth:tokens"];
  return namespaces[Math.floor(Math.random() * namespaces.length)];
}

function generateBusinessRule(): string {
  const rules = [
    "validate_payment_amount",
    "check_inventory_levels",
    "apply_discount_rules",
    "verify_user_permissions",
  ];
  return rules[Math.floor(Math.random() * rules.length)];
}

function generateEmailSubject(): string {
  const subjects = [
    "Order Confirmation",
    "Password Reset",
    "Welcome to Our Service",
    "Monthly Newsletter",
  ];
  return subjects[Math.floor(Math.random() * subjects.length)];
}

function generateFileError(): string {
  const errors = [
    "File too large",
    "Invalid file type",
    "Disk space insufficient",
    "Permission denied",
  ];
  return errors[Math.floor(Math.random() * errors.length)];
}

// Utility function to format log message as string
function formatLogMessage(logMessage: LogMessage): string {
  const metadataStr = logMessage.metadata ? ` | ${JSON.stringify(logMessage.metadata)}` : "";

  return `${logMessage.timestamp} [${logMessage.level}] ${logMessage.component}: ${logMessage.message}${metadataStr}`;
}
