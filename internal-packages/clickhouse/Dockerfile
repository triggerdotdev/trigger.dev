FROM golang


RUN go install github.com/pressly/goose/v3/cmd/goose@latest


COPY ./schema ./schema

ENV GOOSE_DRIVER=clickhouse
ENV GOOSE_DBSTRING="tcp://default:password@clickhouse:9000"
ENV GOOSE_MIGRATION_DIR=./schema

# Run migrations as non-root (dev-only migration helper; goose needs no root).
USER nobody
CMD ["goose", "up"]
