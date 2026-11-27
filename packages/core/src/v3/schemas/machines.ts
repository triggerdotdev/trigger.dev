import { z } from "zod/v4";
import { getEnvVar } from "../utils/getEnv.js";
import { type MachineConfig, MachinePresetName } from "./common.js";

export const MAX_MACHINES = 10;

/**
 * Set by the CLI for its indexer, which collects machines from tasks. An older indexer would drop a
 * task's machine without an error, so the SDK refuses to index one without this.
 */
export const INDEXER_COLLECTS_MACHINES_ENV = "TRIGGER_INDEXER_COLLECTS_MACHINES";

/**
 * A build arg the CLI sets to "1" when the build will produce machine images: a local or native
 * build, against a server that stores them. Without it, indexing fails for tasks on a machine.
 */
export const BUILDS_MACHINE_IMAGES_ARG = "TRIGGER_BUILDS_MACHINE_IMAGES";

/** Becomes part of an image tag and a Containerfile stage name. */
export const MachineId = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/,
    "Machine ids are 1-32 lowercase letters, digits and dashes, and start and end with a letter or digit"
  );

/** A machine defined with `defineMachine()`: an image built on the project image, and a default preset. */
export const NamedMachine = z.object({
  id: MachineId,
  /** The preset tasks on this machine use unless they set their own. */
  preset: MachinePresetName.optional(),
  image: z
    .object({
      /** apt packages to install. */
      pkgs: z.array(z.string()).optional(),
      /** Containerfile instructions, run as root on top of the deployment's image. */
      instructions: z
        .array(
          z
            .string()
            .refine(
              (instruction) => !/^\s*FROM\b/i.test(instruction),
              "Machine instructions cannot start a new stage with FROM"
            )
        )
        .optional(),
    })
    .optional(),
});

export type NamedMachine = z.infer<typeof NamedMachine>;

export const NamedMachines = z
  .array(NamedMachine)
  .max(MAX_MACHINES)
  .superRefine((machines, ctx) => {
    const seen = new Set<string>();
    for (const machine of machines) {
      if (seen.has(machine.id)) {
        ctx.addIssue({ code: "custom", message: `Machine id "${machine.id}" is used twice` });
      }
      seen.add(machine.id);
    }
  });

const WorkerMachines = z.object({ machines: NamedMachines });

/** The machines a worker's tasks use, from its stored metadata. */
export function workerMachinesOf(workerMetadata: unknown): NamedMachine[] | undefined {
  return WorkerMachines.safeParse(workerMetadata).data?.machines;
}

/**
 * The machines used by a worker's tasks, one per id. Two tasks may share a machine id only with the
 * same definition, since only one image is built for it.
 */
export function collectTaskMachines(
  tasks: { id: string; namedMachine?: NamedMachine }[]
): NamedMachine[] {
  const machines = new Map<string, { machine: NamedMachine; taskId: string }>();
  for (const task of tasks) {
    if (!task.namedMachine) {
      continue;
    }
    const parsed = NamedMachine.safeParse(task.namedMachine);
    if (!parsed.success) {
      throw new Error(
        `Task "${task.id}" has an invalid machine: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`
      );
    }
    const machine = parsed.data;
    const existing = machines.get(machine.id);
    if (!existing) {
      machines.set(machine.id, { machine, taskId: task.id });
      continue;
    }
    // Parsed, so both have the schema's key order.
    if (JSON.stringify(existing.machine) !== JSON.stringify(machine)) {
      throw new Error(
        `Tasks "${existing.taskId}" and "${task.id}" use different machines with the id "${machine.id}". Give each machine its own id.`
      );
    }
  }

  const collected = NamedMachines.safeParse([...machines.values()].map(({ machine }) => machine));
  if (!collected.success) {
    throw new Error(
      `Invalid machines: ${collected.error.issues.map((issue) => issue.message).join(", ")}`
    );
  }
  return collected.data;
}

/** Each named machine's image digest, by machine id, sent at finalize. */
export const MachineImageDigests = z
  .record(MachineId, z.string().regex(/^sha256:[a-f0-9]{64}$/))
  .refine((digests) => Object.keys(digests).length <= MAX_MACHINES, {
    message: `At most ${MAX_MACHINES} machines`,
  });

/** The tag a machine's image is pushed under, next to the deployment's own image. */
export function machineImageTag(deploymentImageTag: string, machineId: string): string {
  return `${deploymentImageTag.split("@")[0]}.${machineId}`;
}

/** The image and template a task runs on: its named machine's, or the deployment's own. */
export function resolveTaskImage(
  deployment: { imageReference: string | null; templateKey: string | null },
  machineName: string | undefined,
  /** The deployment's image of `machineName`, if it has one. */
  machine: { imageReference: string; templateKey: string | null } | null | undefined
):
  | { ok: true; machineName?: string; imageReference: string | null; templateKey: string | null }
  | { ok: false; machineName: string } {
  if (!machineName) {
    return {
      ok: true,
      imageReference: deployment.imageReference,
      templateKey: deployment.templateKey,
    };
  }
  if (!machine) {
    return { ok: false, machineName };
  }
  return {
    ok: true,
    machineName,
    imageReference: machine.imageReference,
    templateKey: machine.templateKey,
  };
}

const MachineConfigName = z.object({ name: z.string().optional() });

/** The named machine in a stored task `machineConfig`, if any. */
export function machineNameOf(machineConfig: unknown): string | undefined {
  return MachineConfigName.safeParse(machineConfig).data?.name;
}

/** A machine from `defineMachine()`, rather than a preset or a size. */
export function isNamedMachine(machine: unknown): machine is NamedMachine {
  return typeof machine === "object" && machine !== null && "id" in machine;
}

/** A task's `machine` option as the manifest stores it. */
export function taskMachineConfig(
  machine: MachinePresetName | MachineConfig | NamedMachine | undefined
): MachineConfig | undefined {
  if (typeof machine === "string") {
    return { preset: machine };
  }
  if (isNamedMachine(machine)) {
    return { preset: machine.preset, name: machine.id };
  }
  return machine;
}

/** A task's `machine` option as task metadata: its stored config, and the definition to index. */
export function taskMachineMetadata(
  taskId: string,
  machine: MachinePresetName | MachineConfig | NamedMachine | undefined
): { machine?: MachineConfig; namedMachine?: NamedMachine } {
  if (!isNamedMachine(machine)) {
    return { machine: taskMachineConfig(machine) };
  }
  if (getEnvVar("TRIGGER_INDEXING") === "1" && getEnvVar(INDEXER_COLLECTS_MACHINES_ENV) !== "1") {
    throw new Error(
      `Task "${taskId}" uses a machine from defineMachine(), which needs a newer trigger.dev CLI. Upgrade the CLI and try again.`
    );
  }
  return { machine: taskMachineConfig(machine), namedMachine: machine };
}
