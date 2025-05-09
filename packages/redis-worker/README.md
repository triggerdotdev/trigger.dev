# Redis worker

This is a simple worker that pulls tasks from a Redis queue (also in this package).

Features

- Configurable settings for concurrency and pull speed.
- Job payloads.
- A schema so only defined jobs can be added to the queue.
- The ability to have future dates for jobs.
