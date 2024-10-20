# Blocking message queue

A First-In-First-Out message queue that uses Redis.

You can add messages to the queue with a `key` and `value`. The `key` is used to group messages together.

When consuming messages you pass in an array of `keys` to pull messages from. Messages are returned in the order they were added to the queue. If there are no messages for the keys, it will block other consumers for those keys until the timeout is hit. This makes it easy to use as a message queue.
