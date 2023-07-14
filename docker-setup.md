## Setting up Docker for the first time.

In thc contributing guide of Trigger.dev, there's a section that requires you to start Docker.

If you don't have Docker installed on yiur machine, you'll run into some complications (errors).

Below are the steps on how you can avoid that.

First you need to setup docker-compose as it is an underlying tool that this command: `pnpm run docker` fires behind the scene.

To install Docker Compose on Linux Ubuntu via the terminal, you can follow these steps:

1. Update the package index on your system by running the following command:

   ```shell
   sudo apt update
   ```

2. Install the required dependencies by running the following command:

   ```shell
   sudo apt install curl
   ```

3. Download the Docker Compose binary into the `/usr/local/bin` directory using the `curl` command:

   ```shell
   sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
   ```

4. Set the appropriate permissions to make the `docker-compose` binary executable:

   ```shell
   sudo chmod +x /usr/local/bin/docker-compose
   ```

5. Verify that Docker Compose has been successfully installed by running the following command:

   ```shell
   docker-compose --version
   ```

   This command should display the version information of Docker Compose without any errors.

After following these steps, you should have Docker Compose installed on your Ubuntu system, and you can use it by running `docker-compose` commands in the terminal.

## Windows

1. Download the Docker Desktop installer from the Docker website: [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop)

2. Run the installer and follow the instructions to install Docker Desktop.

3. After installation, Docker Desktop should be running automatically.

## macOS

1. Download the Docker Desktop installer from the Docker website: [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop)

2. Run the installer and follow the instructions to install Docker Desktop.

3. After installation, Docker Desktop should be running automatically.

Please note that the instructions provided above are for the most common scenarios. For specific versions or different distributions, it's always a good idea to consult the official Docker documentation for the respective operating systems.
