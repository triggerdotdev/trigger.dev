## Development

1. Run `brew install libpulsar` to install the C++ libraries that the pulsar-client depends on

2. Make sure you run the following in your terminal before running `pnpm install`:

```sh
export CPLUS_INCLUDE_PATH="$CPLUS_INCLUDE_PATH:$(brew --prefix)/include"
export LIBRARY_PATH="$LIBRARY_PATH:$(brew --prefix)/lib"
export PULSAR_CPP_DIR=/opt/homebrew/Cellar/libpulsar/2.10.2
```
