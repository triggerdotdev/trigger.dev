import { spawn } from "child_process";

export const isLinuxServer = async () => {
  if (process.platform !== "linux") return false;
  const xdgAvailable = await new Promise<boolean>(res => {
    const xdg = spawn("xdg-open");
    xdg.on('error', function () {
      res(false);
    });
    xdg.on("spawn", () => {
      res(true);
    });
    xdg.on("exit", (code) => {
      res(code === 0);
    })
    xdg.unref();
    });
  return !xdgAvailable;
}