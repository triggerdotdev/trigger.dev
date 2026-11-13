# Real secret-proxy binding tests

From the `trigger.dev/apps/supervisor` directory in the Chonk checkout:

```sh
NODE_ENV=test \
NODE_OPTIONS='--conditions=@triggerdotdev/source' \
TRIGGER_API_URL=http://127.0.0.1 \
TRIGGER_WORKER_TOKEN=test-worker \
MANAGED_WORKER_SECRET=test-managed \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1 \
pnpm exec vitest run --config vitest.secret-proxy.config.ts src/services/secretProxyBindings.test.ts
```

Requires a Docker CLI/daemon supporting privileged Linux containers, OpenSSL,
Cargo and the Rust toolchain pinned by `compute/fcrun/rust-toolchain.toml`.
The fixture runs `cargo +1.97.0 build --locked -p fcrun-interceptor` itself,
including on CI. It does not depend on a previously compiled binary or install
npm packages. It honors `SECRET_PROXY_CARGO`
(default `~/.cargo/bin/cargo`) and `SECRET_PROXY_RUST_TOOLCHAIN` (default `1.97.0`).
For the locally installed Rust 1.97.1, set `SECRET_PROXY_RUST_TOOLCHAIN=1.97.1`.
Set `CARGO_NET_OFFLINE=true` only when Cargo dependencies are already cached.

The fixture creates its own k3s container, loads its kubeconfig into memory,
installs the repository's Runner CRD and starts 131 small containerd pause pods.
Both container images are pinned to multiarch manifest-list digests. No user
Kubernetes context or existing cluster is changed. A unique owned container name
is assigned before launch, so cleanup also works if Docker startup fails before
returning its ID. Teardown independently attempts container/volume removal,
bounded interceptor shutdown with SIGKILL escalation, and private-file removal.
Allow ten minutes for a cold native build; warm runs take about a minute.

Coverage is the `SecretProxyBindings` boundary: real Kubernetes placement reads
and the production Rust interceptor's Unix HTTP control handler. A native
`allocation-fixture` child creates a separate loopback TCP listener per real
containerd guest ID, calls `fcrun_wire::proxy_control::send_allocation` with
SCM_RIGHTS, and retains the returned owner streams. It sends the runtime's generic
allocation envelope with opaque metadata; the real interceptor decodes and pins the
run/attempt fields. An actor per allocation
answers the production `OPEN_SOCKET_REQUEST` with an unconnected IPv4 socket
created in the fixture namespace, using `fcrun_wire::proxy_control::send_socket`.
Temporary socket-creation errors reply unavailable without retiring the lease.
Retirement shuts down the owner stream and aborts its actor. No namespace
switching or network capabilities are required by the interceptor. Tests discover allocations
through the production API before PUT and observe binding availability with real
TLS handshakes. Each test first starts/resets the supervisor, then retires the
previous contexts through owner EOF and creates fresh ones. Reset closes every
pre-existing context, including those without a first binding; revocation is
terminal for an allocation.

The suite covers missing/mismatched context preflight, allocation pinning across
replacement, allocation-scoped IDs protecting replacements from delayed old
supervisor DELETEs, fresh DELETE/reset rejecting late first PUTs, admission only
for post-reset contexts, and existing attempt cleanup/retry/capacity behavior. Metadata, token payloads and completion
acknowledgements are explicit authenticated boundary inputs. Tokens are not platform-issued or signature-verified in this suite. No
platform, WorkloadServer, operator, microVM, relay, provider or dataplane E2E
coverage is claimed. The host-native fixture does not create CNI listeners or
claim that pause pods are Firecracker VMs. It exercises the actual FD transfer
and lifetime protocol, not a replacement HTTP service. The helper is a test
binary, not copied into the production interceptor image.

The Rust helper's broker regression starts the production allocation receiver,
requests two upstream sockets through its broker, transfers real TCP bytes, and
checks owner retirement. Run it from the Chonk checkout root with:

```sh
cd compute/fcrun
cargo +1.97.1 test --locked -p fcrun-interceptor --bin allocation-fixture
```

On Linux this also exercises the positive same-namespace cookie validation; it
is not a cross-namespace routing test. The macOS TLS smoke does not use the Linux
original-destination connector, so it does not prove broker forwarding.
