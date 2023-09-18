import { prepareEnvironment } from "@gmrchk/cli-testing-library";
import { CLITestEnvironment } from "@gmrchk/cli-testing-library/lib/types";
import { join } from "node:path";

let environment: CLITestEnvironment;

beforeAll(async () => {
  // This will create a "sandbox" terminal under `/var/folders`
  environment = await prepareEnvironment();
});

afterAll(async () => {
  await environment.cleanup();
});

// this test is not returning timeout
describe.skip('cli', () => {
  // can be any path with a nextjs project
  const NEXT_PROJECT_PATH = join(__dirname, '..', '..', '..', 'examples', 'nextjs-example');

  it('should be able to execute cli', async () => {
    const { waitForText, getStdout, wait, pressKey } = await environment.spawn('node', `${join(__dirname, '..', 'dist', 'index.js')} init -p ${NEXT_PROJECT_PATH}`)

    console.log('getStdout() :>> ', getStdout());

    // this promises never resolves
    // maybe we have a conflict between vitest and @gmrchk/cli-testing-library?
    // with jest works fine, but with vitest not
    await waitForText('Detected Next.js project');

    console.log('getStdout() :>> ', getStdout());

    await waitForText('Are you using the Trigger.dev cloud or self-hosted?');

    console.log('getStdout() :>> ', getStdout());

    await pressKey('enter');

    console.log('getStdout() :>> ', getStdout());

    // wait next prompt, make assertions and keep going
  });
}, 20000)