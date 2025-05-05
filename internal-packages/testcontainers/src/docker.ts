import { x } from "tinyexec";

function stringToLines(str: string): string[] {
  return str.split("\n").filter(Boolean);
}

function lineToWords(line: string): string[] {
  return line.trim().split(/\s+/);
}

async function getDockerNetworks(): Promise<string[]> {
  try {
    const result = await x("docker", ["network", "ls" /* , "--no-trunc" */]);
    return stringToLines(result.stdout);
  } catch (error) {
    console.error(error);
    return ["error: check additional logs for more details"];
  }
}

async function getDockerContainers(): Promise<string[]> {
  try {
    const result = await x("docker", ["ps", "-a" /* , "--no-trunc" */]);
    return stringToLines(result.stdout);
  } catch (error) {
    console.error(error);
    return ["error: check additional logs for more details"];
  }
}

type DockerResource = { id: string; name: string };

type DockerNetworkAttachment = DockerResource & {
  containers: string[];
};

export async function getDockerNetworkAttachments(): Promise<DockerNetworkAttachment[]> {
  let attachments: DockerNetworkAttachment[] = [];
  let networks: DockerResource[] = [];

  try {
    const result = await x("docker", [
      "network",
      "ls",
      "--format",
      '{{.ID | printf "%.12s"}} {{.Name}}',
    ]);

    const lines = stringToLines(result.stdout);

    for (const line of lines) {
      const [id, name] = lineToWords(line);

      if (!id || !name) {
        continue;
      }

      networks.push({ id, name });
    }
  } catch (err) {
    console.error("Failed to list docker networks:", err);
  }

  for (const { id, name } of networks) {
    try {
      // Get containers, one per line: id name\n
      const containersResult = await x("docker", [
        "network",
        "inspect",
        "--format",
        '{{range $k, $v := .Containers}}{{$k | printf "%.12s"}} {{$v.Name}}\n{{end}}',
        id,
      ]);

      const containers = stringToLines(containersResult.stdout);

      attachments.push({ id, name, containers });
    } catch (err) {
      console.error(`Failed to inspect network ${id}:`, err);
      attachments.push({ id, name, containers: [] });
    }
  }

  return attachments;
}

type DockerContainerNetwork = DockerResource & {
  networks: string[];
};

export async function getDockerContainerNetworks(): Promise<DockerContainerNetwork[]> {
  let results: DockerContainerNetwork[] = [];
  let containers: DockerResource[] = [];

  try {
    const result = await x("docker", [
      "ps",
      "-a",
      "--format",
      '{{.ID | printf "%.12s"}} {{.Names}}',
    ]);

    const lines = stringToLines(result.stdout);

    for (const line of lines) {
      const [id, name] = lineToWords(line);

      if (!id || !name) {
        continue;
      }

      containers.push({ id, name });
    }
  } catch (err) {
    console.error("Failed to list docker containers:", err);
  }

  for (const { id, name } of containers) {
    try {
      const inspectResult = await x("docker", [
        "inspect",
        "--format",
        '{{ range $k, $v := .NetworkSettings.Networks }}{{ $k | printf "%.12s" }} {{ $v.Name }}\n{{ end }}',
        id,
      ]);

      const networks = stringToLines(inspectResult.stdout);

      results.push({ id, name, networks });
    } catch (err) {
      console.error(`Failed to inspect container ${id}:`, err);
      results.push({ id, name: String(err), networks: [] });
    }
  }

  return results;
}

export type DockerDiagnostics = {
  containers?: string[];
  networks?: string[];
  containerNetworks?: DockerContainerNetwork[];
  networkAttachments?: DockerNetworkAttachment[];
};

export async function getDockerDiagnostics(): Promise<DockerDiagnostics> {
  const [containers, networks, networkAttachments, containerNetworks] = await Promise.all([
    getDockerContainers(),
    getDockerNetworks(),
    getDockerNetworkAttachments(),
    getDockerContainerNetworks(),
  ]);

  return {
    containers,
    networks,
    containerNetworks,
    networkAttachments,
  };
}
