#!/bin/bash

set -e

prometheus --config.file=./.configs/prometheus.yml --storage.tsdb.path=/tmp/prom-data