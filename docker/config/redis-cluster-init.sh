#!/bin/sh
# Brings up a six-node Redis cluster (3 masters, 3 replicas) inside ONE container.
#
# One container, not six, for two reasons that both come from Docker on macOS:
#
#   1. Cluster nodes gossip with each other using the address they ADVERTISE. Six separate
#      containers each advertising 127.0.0.1 would each be talking to themselves, and the cluster
#      never forms. Sharing one network namespace makes 127.0.0.1 mean the same thing to all six.
#   2. A client on the host follows MOVED redirects to that same advertised address, so the ports
#      published below resolve correctly from outside.
#
# Each node gets its own directory: six nodes sharing one working directory fight over nodes.conf
# and all but the first fail to start, silently, because they are daemonised.
set -e

NODES="1 2 3 4 5 6"

for i in $NODES; do
  PORT=$((7000 + i))
  BUS=$((17000 + i))
  mkdir -p "/data/$PORT"
  redis-server \
    --port "$PORT" \
    --cluster-enabled yes \
    --cluster-node-timeout 5000 \
    --cluster-announce-ip 127.0.0.1 \
    --cluster-announce-port "$PORT" \
    --cluster-announce-bus-port "$BUS" \
    --cluster-config-file "nodes-$PORT.conf" \
    --dir "/data/$PORT" \
    --protected-mode no \
    --appendonly no \
    --save '' \
    --logfile "/data/$PORT/redis.log" \
    --daemonize yes
done

# Daemonised servers report failures only to their own log, so check before forming the cluster.
sleep 5
for i in $NODES; do
  PORT=$((7000 + i))
  if ! redis-cli -p "$PORT" ping >/dev/null 2>&1; then
    echo "node $PORT failed to start:"
    tail -20 "/data/$PORT/redis.log"
    exit 1
  fi
done

# Idempotent: a restart with a populated /data already has slots assigned, so skip the create.
if redis-cli -p 7001 cluster info | grep -q "cluster_state:ok"; then
  echo "cluster already formed"
else
  redis-cli --cluster create \
    127.0.0.1:7001 127.0.0.1:7002 127.0.0.1:7003 \
    127.0.0.1:7004 127.0.0.1:7005 127.0.0.1:7006 \
    --cluster-replicas 1 --cluster-yes
fi

redis-cli -p 7001 cluster info | grep -E "cluster_state|cluster_size"
exec tail -f /dev/null
