This guide covers installing Docker and Docker Compose. If you're looking for instructions for running Trigger.dev in docker, [see here](https://github.com/triggerdotdev/docker).

## Setting up Docker for the first time.

In the contributing guide of Trigger.dev, there's a section that requires you to start Docker.

If you don't have Docker installed on your machine, you'll run into some complications (errors).

Below are the steps on how you can avoid that.

First you need to setup docker compose as it is an underlying tool that this command: `pnpm run docker` fires behind the scene.

## Linux

To install Docker Compose on Linux Ubuntu, you can follow these steps:

1. Create the Docker config directory and cli-plugins subdirectory:

   ```shell
   DOCKER_CONFIG=${DOCKER_CONFIG:-$HOME/.docker}
   mkdir -p $DOCKER_CONFIG/cli-plugins
   ```

2. Download the Docker Compose plugin:

   ```shell
   curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o $DOCKER_CONFIG/cli-plugins/docker-compose
   ```

   Note:

   - To install for all users, replace `$DOCKER_CONFIG/cli-plugins` with `/usr/local/lib/docker/cli-plugins`

3. Set the appropriate permissions to make the Docker Compose plugin executable:

   ```shell
   chmod +x $DOCKER_CONFIG/cli-plugins/docker-compose
   ```

   If you installed for all users:

   ```shell
   sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
   ```

4. Verify that Docker Compose has been successfully installed:

   ```shell
   docker compose version
   ```

   You should see output similar to:

   ```
   Docker Compose version vX.Y.Z
   ```

After following these steps, you should have Docker Compose installed on your Ubuntu system, and you can use it by running `docker compose` commands in the terminal.

When you've verified that the `docker compose` package is installed and you proceed to start Docker with `pnpm run docker`.

You'll probably get an error similar to the one below:

```shell
Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?
 ELIFECYCLE  Command failed with exit code 1.
```

The error message suggests that the Docker daemon is not running on your system. The Docker daemon is responsible for managing and running Docker containers.

To resolve this issue, you may need to install Docker properly on your Ubuntu system. Here are the steps to install Docker on Ubuntu:

1. Update the package index on your system by running the following command:

   ```shell
   sudo apt update
   ```

2. Install the necessary packages to allow apt to use repositories over HTTPS:

   ```shell
   sudo apt install apt-transport-https ca-certificates curl software-properties-common
   ```

3. Add the official Docker GPG key to your system by running the following command:

   ```shell
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
   ```

4. Add the Docker repository to the APT sources list:

   ```shell
   echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
   ```

5. Update the package index again:

   ```shell
   sudo apt update
   ```

6. Install Docker by running the following command:

   ```shell
   sudo apt install docker-ce docker-ce-cli containerd.io
   ```

7. After the installation is complete, verify that Docker is installed correctly by running the following command:

   ```shell
   docker --version
   ```

   This command should display the version information of Docker without any errors.

Once Docker is installed and verified, you should be able to start the Docker daemon and run the `pnpm run docker` command without encountering any issues.

## Windows

1. Download the Docker Desktop installer from the Docker website: [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop)

2. Run the installer and follow the instructions to install Docker Desktop.

3. After installation, Docker Desktop should be running automatically.

## macOS

1. Download the Docker Desktop installer from the Docker website: [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop)

2. Run the installer and follow the instructions to install Docker Desktop.

3. After installation, Docker Desktop should be running automatically.

Please note that the instructions provided above are for the most common scenarios. For specific versions or different distributions, it's always a good idea to consult the official Docker documentation for the respective operating systems.
