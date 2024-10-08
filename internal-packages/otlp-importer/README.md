# OTLP Importer

## Getting started

Install dependencies:

```sh Mac
brew install protobuf
```

```sh Linux
apt install -y protobuf-compiler
```

Alternatively, follow the [manual install instructions](https://github.com/protocolbuffers/protobuf?tab=readme-ov-file#protobuf-compiler-installation) for the protobuf compiler.

On Windows, download the correct binary from the [latest release](https://github.com/protocolbuffers/protobuf/releases) and extract the `protoc` binary to this directory, or add it to your `PATH`.

## Submodules

**Submodule is always pointing to certain revision number. So updating the submodule repo will not have impact on your code.
Knowing this if you want to change the submodule to point to a different version (when for example proto has changed) here is how to do it:**

### Updating submodule to point to certain revision number

1. Make sure you are in the same folder as this instruction

2. Update your submodules by running this command

   ```shell script
   git submodule sync --recursive
   git submodule update --init --recursive
   ```

3. Find the SHA which you want to update to and copy it (the long one)
   the latest sha when this guide was written is `c451441d7b73f702d1647574c730daf7786f188c`

4. Enter a submodule directory from this directory

   ```shell script
   cd protos
   ```

5. Updates files in the submodule tree to given commit:

   ```shell script
   git checkout -q <sha>
   ```

6. Return to the main directory:

   ```shell script
   cd ../
   ```

7. Please run `git status` you should see something like `Head detached at`. This is correct, go to next step

8. Now thing which is very important. You have to commit this to apply these changes

   ```shell script
   git commit -am "chore: updating protos submodule for @trigger.dev/otlp-importer"
   ```

9. If you look now at git log you will notice that the folder `protos` has been changed and it will show what was the previous sha and what is current one.
