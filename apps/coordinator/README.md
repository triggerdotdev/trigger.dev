## Development

1. Run `brew install libpulsar` to install the C++ libraries that the pulsar-client depends on

2. Make sure you have Python installed on your machine by running `which python3` in terminal.

3. If python isn't found then you should install it: https://www.python.org/downloads/. In a new terminal window run `which python3` again.

4. Run `npm config set python /the/path/from/the/which/python3/command` inserting the path from step 2 or 3

5. Install node-gyp: `npm install -g node-gyp`

6. Make sure you have the Xcode command line tools installed by running `xcode-select --install` from the terminal

7. Run this in the terminal:

```sh
export CPLUS_INCLUDE_PATH="$CPLUS_INCLUDE_PATH:$(brew --prefix)/include"
export LIBRARY_PATH="$LIBRARY_PATH:$(brew --prefix)/lib"
export PULSAR_CPP_DIR=/opt/homebrew/Cellar/libpulsar/3.1.0
```

8. Run `pnpm install`
