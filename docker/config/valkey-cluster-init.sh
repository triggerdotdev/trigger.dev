#!/bin/sh
# Brings up a six-node Valkey cluster (3 primaries, 3 replicas) inside ONE container, for the
# webhook engine's Redis in cluster mode.
#
# It is one container for the same reasons as redis-cluster-init.sh: the nodes must agree on the
# address they advertise, and a client on the host follows MOVED redirects to that address. Each
# node listens on its published host port, so 127.0.0.1:<port> means the same node inside the
# container and on the host, and every port is offset per stack like the other *_HOST_PORT values.
#
# The cluster bus listens on port + 10000. It never leaves the container, so it is not published.
#
# Pause a node to simulate a hang, or kill it to simulate a crash:
#   docker exec <container> valkey-cli -p <port> DEBUG SLEEP 30
#   docker exec <container> sh -c 'kill -9 $(cat /data/<port>/valkey.pid)'
# and bring a killed node back (it rejoins as a replica of whichever node took over):
#   docker exec <container> sh /init.sh start <port>
set -e

PORTS="$VALKEY_CLUSTER_PORTS"

start_node() {
  PORT=$1
  mkdir -p "/data/$PORT"
  valkey-server \
    --port "$PORT" \
    --cluster-enabled yes \
    --cluster-node-timeout 5000 \
    --cluster-announce-ip 127.0.0.1 \
    --cluster-announce-port "$PORT" \
    --cluster-announce-bus-port $((PORT + 10000)) \
    --cluster-config-file "nodes-$PORT.conf" \
    --dir "/data/$PORT" \
    --protected-mode no \
    --maxmemory-policy noeviction \
    --appendonly no \
    --save '' \
    --pidfile "/data/$PORT/valkey.pid" \
    --logfile "/data/$PORT/valkey.log" \
    --daemonize yes
}

if [ "$1" = "start" ]; then
  start_node "$2"
  exit 0
fi

for PORT in $PORTS; do
  start_node "$PORT"
done

# Daemonised servers report failures only to their own log, so check before forming the cluster.
sleep 2
for PORT in $PORTS; do
  if ! valkey-cli -p "$PORT" ping >/dev/null 2>&1; then
    echo "node $PORT failed to start:"
    tail -20 "/data/$PORT/valkey.log"
    exit 1
  fi
done

FIRST=$(echo $PORTS | cut -d' ' -f1)
if valkey-cli -p "$FIRST" cluster info | grep -q "cluster_state:ok"; then
  echo "cluster already formed"
else
  # shellcheck disable=SC2046
  valkey-cli --cluster create $(for PORT in $PORTS; do printf '127.0.0.1:%s ' "$PORT"; done) \
    --cluster-replicas 1 --cluster-yes
fi

valkey-cli -p "$FIRST" cluster info | grep -E "cluster_state|cluster_size"
exec tail -f /dev/null
