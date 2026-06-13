FROM golang:1.26@sha256:68cb6d68bed024785b69195b89af7ac7a444f27791435f98647edff595aa0479


RUN go install github.com/pressly/goose/v3/cmd/goose@v3.27.1


COPY ./schema ./schema

ENV GOOSE_DRIVER=clickhouse
ENV GOOSE_DBSTRING="tcp://default:password@clickhouse:9000"
ENV GOOSE_MIGRATION_DIR=./schema

# Run migrations as non-root (dev-only migration helper; goose needs no root).
USER nobody
CMD ["goose", "up"]
