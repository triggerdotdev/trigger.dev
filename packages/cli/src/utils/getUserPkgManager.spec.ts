import { randomUUID } from "crypto";
import { pathExists } from "./fileSystem";
import { getUserPackageManager } from "./getUserPkgManager";
import * as pathModule from "path";

jest.mock('path', () => ({
  join: jest.fn().mockImplementation((...paths: string[]) => paths.join('/')),
}))

jest.mock('./fileSystem', () => ({
  pathExists: jest.fn().mockResolvedValue(false),
}));

describe(getUserPackageManager.name, () => {
  let path: string;

  beforeEach(() => {
    path = randomUUID();
  });

  afterEach(jest.clearAllMocks);

  describe(`should use ${pathExists.name} to check for package manager artifacts`, () => {
    it('should join the path with the artifact name', async () => {
      await getUserPackageManager(path);

      expect(pathModule.join).toBeCalledWith(path, 'yarn.lock');
      expect(pathModule.join).toBeCalledWith(path, 'pnpm-lock.yaml');
      expect(pathModule.join).toBeCalledWith(path, 'package-lock.json');
    });

    it(`should call ${pathExists.name} with the path.join result`, async () => {
      const expected = randomUUID();

      (pathModule.join as jest.Mock).mockReturnValueOnce(expected);

      await getUserPackageManager(path);

      expect(pathExists).toBeCalledWith(expected);
    });

    it('should return "yarn" if yarn.lock exists', async () => {
      (pathExists as jest.Mock).mockImplementation((path: string) => path.endsWith('yarn.lock'));

      expect(await getUserPackageManager(path)).toBe('yarn');
    });

    it('should return "pnpm" if pnpm-lock.yaml exists', async () => {
      (pathExists as jest.Mock).mockImplementation(async (path: string) => path.endsWith('pnpm-lock.yaml'));

      expect(await getUserPackageManager(path)).toBe('pnpm');
    });

    it('should return "npm" if package-lock.json exists', async () => {
      (pathExists as jest.Mock).mockImplementation((path: string) => path.endsWith('package-lock.json'));

      expect(await getUserPackageManager(path)).toBe('npm');
    });

    it('should return "npm" if npm-shrinkwrap.json exists', async () => {
      (pathExists as jest.Mock).mockImplementation((path: string) => path.endsWith('npm-shrinkwrap.json'));

      expect(await getUserPackageManager(path)).toBe('npm');
    });
  });
  
  describe(`if doesn't found artifacts, should use process.env.npm_config_user_agent to detect package manager`, () => {
    beforeEach(() => {
      (pathExists as jest.Mock).mockResolvedValue(false);
    })

    it('should return "yarn" if process.env.npm_config_user_agent starts with "yarn"', async () => {
      process.env.npm_config_user_agent = 'yarn';

      expect(await getUserPackageManager(path)).toBe('yarn');
    });

    it('should return "pnpm" if process.env.npm_config_user_agent starts with "pnpm"', async () => {
      process.env.npm_config_user_agent = 'pnpm';

      expect(await getUserPackageManager(path)).toBe('pnpm');
    });

    it('if doesn\'t start with "yarn" or "pnpm", should return "npm"', async () => {
      process.env.npm_config_user_agent = randomUUID();

      expect(await getUserPackageManager(path)).toBe('npm');
    });

    it('should return "npm" if process.env.npm_config_user_agent is not set', async () => {
      delete process.env.npm_config_user_agent;

      expect(await getUserPackageManager(path)).toBe('npm');
    });
  });
})