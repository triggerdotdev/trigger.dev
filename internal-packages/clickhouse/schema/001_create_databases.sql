-- +goose up

CREATE DATABASE trigger_dev;

-- +goose down
DROP DATABASE trigger_dev;
