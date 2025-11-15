#!/bin/bash
# Test script for Python workers

set -e

# Set up Python path to find the SDK (for dev mode)
export PYTHONPATH="$(pwd)/packages/python-sdk:$PYTHONPATH"

echo "Testing Python Index Worker..."

# Create test manifest
cat > /tmp/test-manifest.json << EOF
{
  "tasks": [
    {
      "filePath": "$(pwd)/packages/cli-v3/tests/python/test-task.py"
    }
  ]
}
EOF

# Run index worker
export TRIGGER_MANIFEST_PATH=/tmp/test-manifest.json
python3 packages/cli-v3/src/entryPoints/python/managed-index-worker.py > /tmp/index-output.json

# Verify output
if grep -q "INDEX_TASKS_COMPLETE" /tmp/index-output.json; then
    echo "✓ Index worker completed successfully"
    cat /tmp/index-output.json | jq '.tasks | length'
else
    echo "✗ Index worker failed"
    cat /tmp/index-output.json
    exit 1
fi

echo ""
echo "Testing Python Run Worker..."

# Create execution message (single-line JSON for line-delimited format)
cat > /tmp/execution.json << 'EOF'
{"type":"EXECUTE_TASK_RUN","version":"v1","execution":{"task":{"id":"test-python-task","filePath":"__TASK_FILE_PATH__","exportName":"test-python-task"},"run":{"id":"run_test123","payload":"{\"name\":\"Test\"}","payloadType":"application/json","tags":[],"isTest":true},"attempt":{"id":"attempt_test123","number":1,"startedAt":"2024-01-01T00:00:00Z","backgroundWorkerId":"worker_test","backgroundWorkerTaskId":"task_test"}}}
EOF

# Replace placeholder with actual path
sed -i '' "s|__TASK_FILE_PATH__|$(pwd)/packages/cli-v3/tests/python/test-task.py|g" /tmp/execution.json

# Run execution worker
cat /tmp/execution.json | python3 packages/cli-v3/src/entryPoints/python/managed-run-worker.py > /tmp/run-output.json 2>&1 &
WORKER_PID=$!

# Wait for completion (max 10 seconds)
for i in {1..10}; do
    if ! kill -0 $WORKER_PID 2>/dev/null; then
        break
    fi
    sleep 1
done

# Check results
if grep -q "TASK_RUN_COMPLETED" /tmp/run-output.json; then
    echo "✓ Run worker completed successfully"
    cat /tmp/run-output.json | jq '.completion.output'
else
    echo "✗ Run worker failed"
    cat /tmp/run-output.json
    exit 1
fi

echo ""
echo "All worker tests passed!"
