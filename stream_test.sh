#!/bin/zsh

(
  echo -n '{"message": "chunk 1"}\n'
  sleep 1
  echo -n '{"message": "chunk 2"}\n'
  sleep 1
  echo -n '{"message": "chunk 3"}\n'
  sleep 1
  echo -n '{"message": "chunk 4"}\n'
) | curl -v -X POST "http://localhost:3030/realtime/v1/streams/express/test" \
     -H "Content-Type: application/x-ndjson" \
     --data-binary @-