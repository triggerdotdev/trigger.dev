import { envvars, logger, task } from "@trigger.dev/sdk";
import assert from "node:assert";

export const secretEnvVar = task({
  id: "secret-env-var",
  retry: {
    maxAttempts: 1,
  },
  run: async (_, { ctx }) => {
    logger.log("ctx", { ctx });

    logger.log("process.env", process.env);

    //list them
    const vars = await envvars.list(ctx.project.ref, ctx.environment.slug);
    logger.log("envVars", { vars });

    //get non secret env var
    const nonSecretEnvVar = vars.find((v) => !v.isSecret);
    assert.equal(nonSecretEnvVar?.isSecret, false);
    assert.notEqual(nonSecretEnvVar?.value, "<redacted>");

    //retrieve the non secret env var
    const retrievedNonSecret = await envvars.retrieve(
      ctx.project.ref,
      ctx.environment.slug,
      nonSecretEnvVar!.name
    );
    logger.log("retrievedNonSecret", { retrievedNonSecret });
    assert.equal(retrievedNonSecret?.isSecret, false);
    assert.equal(retrievedNonSecret?.value, nonSecretEnvVar!.value);

    //get secret env var
    const secretEnvVar = vars.find((v) => v.isSecret);
    assert.equal(secretEnvVar?.isSecret, true);
    assert.equal(secretEnvVar?.value, "<redacted>");

    //retrieve the secret env var
    const retrievedSecret = await envvars.retrieve(
      ctx.project.ref,
      ctx.environment.slug,
      secretEnvVar!.name
    );
    logger.log("retrievedSecret", { retrievedSecret });
    assert.equal(retrievedSecret?.isSecret, true);
    assert.equal(retrievedSecret?.value, "<redacted>");
  },
});
