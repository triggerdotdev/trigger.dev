import { expect, it } from "vitest";
import {
  createGitSettingsAutosave,
  type GitSettingsValues,
  type AutosaveState,
} from "./gitSettingsAutosave";

const initial: GitSettingsValues = {
  productionBranch: "main",
  stagingBranch: "staging",
  previewDeploymentsEnabled: true,
};
function harness() {
  const scheduled = new Set<() => void>();
  const writes: {
    values: GitSettingsValues;
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];
  let state: AutosaveState = { pending: false, saving: false };
  const controller = createGitSettingsAutosave({
    initial,
    changed: (next) => {
      state = next;
    },
    schedule: (callback) => {
      scheduled.add(callback);
      return () => {
        scheduled.delete(callback);
      };
    },
    save: (values) =>
      new Promise<void>((resolve, reject) => writes.push({ values, resolve, reject })),
  });
  return {
    controller,
    writes,
    state: () => state,
    tick: () => {
      const jobs = [...scheduled];
      scheduled.clear();
      jobs.forEach((callback) => callback());
    },
  };
}

it("debounces the whole form, including toggles, and skips unchanged snapshots", async () => {
  const h = harness();
  h.controller.update({ ...initial, productionBranch: "release" });
  h.controller.update({
    ...initial,
    productionBranch: "release",
    previewDeploymentsEnabled: false,
  });
  expect(h.writes).toHaveLength(0);
  expect(h.state().pending).toBe(true);
  h.tick();
  expect(h.writes).toHaveLength(1);
  expect(h.writes[0].values).toEqual({
    ...initial,
    productionBranch: "release",
    previewDeploymentsEnabled: false,
  });
  h.writes[0].resolve();
  await Promise.resolve();
  expect(h.state().pending).toBe(false);
  h.controller.update({ ...h.writes[0].values, productionBranch: " release " });
  h.tick();
  expect(h.writes).toHaveLength(1);
});

it("serializes writes and persists a revert made while an older save is in flight", async () => {
  const h = harness();
  h.controller.update({ ...initial, productionBranch: "release" });
  h.tick();
  h.controller.update({ ...initial, stagingBranch: "new-stage" });
  h.tick();
  h.controller.update(initial);
  h.tick();
  expect(h.writes).toHaveLength(1);
  expect(h.state().pending).toBe(true);
  h.writes[0].resolve();
  await Promise.resolve();
  expect(h.writes).toHaveLength(2);
  expect(h.writes[1].values).toEqual(initial);
  h.writes[1].resolve();
  await Promise.resolve();
  expect(h.state()).toEqual({ pending: false, saving: false, error: undefined });
});

it("retains edits and blocks deployment on failure, retries explicitly, and drains queued writes on disposal", async () => {
  const h = harness();
  h.controller.update({ ...initial, productionBranch: "missing" });
  h.tick();
  h.writes[0].reject(new Error("Production tracking branch not found"));
  await Promise.resolve();
  expect(h.state()).toEqual({
    pending: true,
    saving: false,
    error: "Production tracking branch not found",
  });
  h.tick();
  expect(h.writes).toHaveLength(1);
  h.controller.retry();
  h.tick();
  expect(h.writes).toHaveLength(2);
  h.controller.update(initial);
  h.tick();
  h.controller.dispose();
  h.writes[1].resolve();
  await Promise.resolve();
  expect(h.writes).toHaveLength(3);
  expect(h.writes[2].values).toEqual(initial);
  h.writes[2].resolve();
  await Promise.resolve();
});

it("re-saves even a reverted value after an uncertain network response", async () => {
  const h = harness();
  h.controller.update({ ...initial, productionBranch: "release" });
  h.tick();
  h.writes[0].reject(new Error("Network disconnected"));
  await Promise.resolve();
  h.controller.update(initial);
  h.tick();
  expect(h.writes).toHaveLength(2);
  expect(h.writes[1].values).toEqual(initial);
  h.writes[1].resolve();
  await Promise.resolve();
  expect(h.state().pending).toBe(false);
});

it("persists the latest edit when disposed before the debounce fires", async () => {
  const h = harness();
  h.controller.update({ ...initial, productionBranch: "release" });
  const latest = { ...initial, productionBranch: "release", previewDeploymentsEnabled: false };
  h.controller.update(latest);
  h.controller.dispose();
  expect(h.writes).toHaveLength(1);
  expect(h.writes[0].values).toEqual(latest);
  const detachedState = h.state();
  h.writes[0].resolve();
  await Promise.resolve();
  h.tick();
  expect(h.writes).toHaveLength(1);
  expect(h.state()).toBe(detachedState);
});

it("drains an edit queued behind an in-flight save when disposed before debounce", async () => {
  const h = harness();
  h.controller.update({ ...initial, productionBranch: "release" });
  h.tick();
  const latest = { ...initial, productionBranch: "release", stagingBranch: "next" };
  h.controller.update(latest);
  h.controller.dispose();
  expect(h.writes).toHaveLength(1);
  h.writes[0].resolve();
  await Promise.resolve();
  expect(h.writes).toHaveLength(2);
  expect(h.writes[1].values).toEqual(latest);
  h.writes[1].resolve();
  await Promise.resolve();
});
