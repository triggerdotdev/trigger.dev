CREATE SCHEMA IF NOT EXISTS triggerdotdev_events;

DROP TABLE IF EXISTS triggerdotdev_events.run_executions;

CREATE TABLE triggerdotdev_events.run_executions (
  id SERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type INT NOT NULL,
  drift_amount_in_ms INT NOT NULL DEFAULT 0
);

CREATE INDEX ON triggerdotdev_events.run_executions (event_time);