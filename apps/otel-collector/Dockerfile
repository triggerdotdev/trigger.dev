FROM otel/opentelemetry-collector-contrib

COPY ./otel-collector-config.yaml /etc/otel/config.yaml

EXPOSE 4317 4318 55680 55679

CMD ["--config", "/etc/otel/config.yaml"]
