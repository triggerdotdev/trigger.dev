{{/*
Expand the name of the chart.
*/}}
{{- define "trigger-v4.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "trigger-v4.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "trigger-v4.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "trigger-v4.labels" -}}
helm.sh/chart: {{ include "trigger-v4.chart" . }}
{{ include "trigger-v4.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "trigger-v4.selectorLabels" -}}
app.kubernetes.io/name: {{ include "trigger-v4.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Component labels
*/}}
{{- define "trigger-v4.componentLabels" -}}
{{ include "trigger-v4.labels" . }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Component selector labels
*/}}
{{- define "trigger-v4.componentSelectorLabels" -}}
{{ include "trigger-v4.selectorLabels" . }}
app.kubernetes.io/component: {{ .component }}
{{- end }}


{{/*
Get the full image name for webapp
*/}}
{{- define "trigger-v4.image" -}}
{{- $registry := .Values.global.imageRegistry | default .Values.webapp.image.registry -}}
{{- $repository := .Values.webapp.image.repository -}}
{{- $tag := .Values.webapp.image.tag | default .Chart.AppVersion -}}
{{- if $registry }}
{{- printf "%s/%s:%s" $registry $repository $tag }}
{{- else }}
{{- printf "%s:%s" $repository $tag }}
{{- end }}
{{- end }}

{{/*
Get the full image name for supervisor
*/}}
{{- define "trigger-v4.supervisor.image" -}}
{{- $registry := .Values.global.imageRegistry | default .Values.supervisor.image.registry -}}
{{- $repository := .Values.supervisor.image.repository -}}
{{- $tag := .Values.supervisor.image.tag | default .Chart.AppVersion -}}
{{- if $registry }}
{{- printf "%s/%s:%s" $registry $repository $tag }}
{{- else }}
{{- printf "%s:%s" $repository $tag }}
{{- end }}
{{- end }}

{{/*
PostgreSQL hostname
*/}}
{{- define "trigger-v4.postgres.hostname" -}}
{{- if .Values.postgres.host }}
{{- .Values.postgres.host }}
{{- else if .Values.postgres.deploy }}
{{- printf "%s-postgres" .Release.Name }}
{{- end }}
{{- end }}

{{/*
PostgreSQL connection string
*/}}
{{- define "trigger-v4.postgres.connectionString" -}}
{{- if .Values.postgres.host -}}
postgresql://{{ .Values.postgres.username }}:{{ .Values.postgres.password }}@{{ .Values.postgres.host }}:{{ .Values.postgres.port | default 5432 }}/{{ .Values.postgres.database }}?schema={{ .Values.postgres.schema | default "public" }}&sslmode={{ .Values.postgres.sslMode | default "prefer" }}
{{- else if .Values.postgres.deploy -}}
postgresql://{{ .Values.postgres.auth.username }}:{{ .Values.postgres.auth.password }}@{{ include "trigger-v4.postgres.hostname" . }}:5432/{{ .Values.postgres.auth.database }}?schema={{ .Values.postgres.connection.schema | default "public" }}&sslmode={{ .Values.postgres.connection.sslMode | default "prefer" }}
{{- end -}}
{{- end }}

{{/*
Redis hostname
*/}}
{{- define "trigger-v4.redis.hostname" -}}
{{- if .Values.redis.host }}
{{- .Values.redis.host }}
{{- else if .Values.redis.deploy }}
{{- printf "%s-redis-master" .Release.Name }}
{{- end }}
{{- end }}

{{/*
Redis connection details
*/}}
{{- define "trigger-v4.redis.host" -}}
{{- include "trigger-v4.redis.hostname" . }}
{{- end }}

{{- define "trigger-v4.redis.port" -}}
{{- if .Values.redis.host -}}
{{ .Values.redis.port | default 6379 }}
{{- else if .Values.redis.deploy -}}
6379
{{- end -}}
{{- end }}

{{/*
Electric service URL
*/}}
{{- define "trigger-v4.electric.url" -}}
{{- if .Values.electric.deploy -}}
http://{{ include "trigger-v4.fullname" . }}-electric:{{ .Values.electric.service.port }}
{{- else -}}
{{ .Values.electric.external.url }}
{{- end -}}
{{- end }}

{{/*
ClickHouse hostname
*/}}
{{- define "trigger-v4.clickhouse.hostname" -}}
{{- if .Values.clickhouse.host }}
{{- .Values.clickhouse.host }}
{{- else if .Values.clickhouse.deploy }}
{{- printf "%s-clickhouse" .Release.Name }}
{{- end }}
{{- end }}

{{/*
ClickHouse URL for application (with secure parameter)
*/}}
{{- define "trigger-v4.clickhouse.url" -}}
{{- if .Values.clickhouse.deploy -}}
{{- $protocol := ternary "https" "http" .Values.clickhouse.secure -}}
{{- $secure := ternary "true" "false" .Values.clickhouse.secure -}}
{{ $protocol }}://{{ .Values.clickhouse.auth.username }}:{{ .Values.clickhouse.auth.password }}@{{ include "trigger-v4.clickhouse.hostname" . }}:8123?secure={{ $secure }}
{{- else if .Values.clickhouse.external.host -}}
{{- $protocol := ternary "https" "http" .Values.clickhouse.external.secure -}}
{{- $secure := ternary "true" "false" .Values.clickhouse.external.secure -}}
{{ $protocol }}://{{ .Values.clickhouse.external.username }}:{{ .Values.clickhouse.external.password }}@{{ .Values.clickhouse.external.host }}:{{ .Values.clickhouse.external.httpPort | default 8123 }}?secure={{ $secure }}
{{- end -}}
{{- end }}

{{/*
ClickHouse URL for replication (without secure parameter)
*/}}
{{- define "trigger-v4.clickhouse.replication.url" -}}
{{- if .Values.clickhouse.deploy -}}
{{- $protocol := ternary "https" "http" .Values.clickhouse.secure -}}
{{ $protocol }}://{{ .Values.clickhouse.auth.username }}:{{ .Values.clickhouse.auth.password }}@{{ include "trigger-v4.clickhouse.hostname" . }}:8123
{{- else if .Values.clickhouse.external.host -}}
{{- $protocol := ternary "https" "http" .Values.clickhouse.external.secure -}}
{{ $protocol }}://{{ .Values.clickhouse.external.username }}:{{ .Values.clickhouse.external.password }}@{{ .Values.clickhouse.external.host }}:{{ .Values.clickhouse.external.httpPort | default 8123 }}
{{- end -}}
{{- end }}

{{/*
S3 hostname
*/}}
{{- define "trigger-v4.s3.hostname" -}}
{{- if .Values.s3.external.endpoint }}
{{- .Values.s3.external.endpoint }}
{{- else if .Values.s3.deploy }}
{{- printf "http://%s-minio:9000" .Release.Name }}
{{- end }}
{{- end }}

{{/*
S3 connection details
*/}}
{{- define "trigger-v4.s3.url" -}}
{{- include "trigger-v4.s3.hostname" . }}
{{- end }}

{{/*
Backward compatibility - MinIO helpers (deprecated)
*/}}
{{- define "trigger-v4.minio.hostname" -}}
{{- include "trigger-v4.s3.hostname" . }}
{{- end }}

{{- define "trigger-v4.minio.url" -}}
{{- include "trigger-v4.s3.url" . }}
{{- end }}

{{/*
Get the secrets name - either existing secret or generated name
*/}}
{{- define "trigger-v4.secretsName" -}}
{{- if .Values.secrets.existingSecret -}}
{{ .Values.secrets.existingSecret }}
{{- else -}}
{{ include "trigger-v4.fullname" . }}-secrets
{{- end -}}
{{- end }}

{{/*
Registry connection details
*/}}
{{- define "trigger-v4.registry.host" -}}
{{- if .Values.registry.deploy -}}
{{ .Values.registry.host }}
{{- else -}}
{{ .Values.registry.external.host }}
{{- end -}}
{{- end }}

{{/*
PostgreSQL host (for wait-for-it script)
*/}}
{{- define "trigger-v4.postgres.host" -}}
{{- if .Values.postgres.host -}}
{{ .Values.postgres.host }}:{{ .Values.postgres.port | default 5432 }}
{{- else if .Values.postgres.deploy -}}
{{ include "trigger-v4.postgres.hostname" . }}:5432
{{- end -}}
{{- end }}

{{/*
Supervisor connection details
*/}}
{{- define "trigger-v4.supervisor.url" -}}
{{- if .Values.supervisor.enabled -}}
http://{{ include "trigger-v4.fullname" . }}-supervisor:{{ .Values.supervisor.service.ports.workload }}
{{- else -}}
""
{{- end -}}
{{- end }}

{{/*
Create the name of the supervisor service account to use
*/}}
{{- define "trigger-v4.supervisorServiceAccountName" -}}
{{- if .Values.supervisor.serviceAccount.create }}
{{- default (printf "%s-supervisor" (include "trigger-v4.fullname" .)) .Values.supervisor.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.supervisor.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Create the name of the supervisor cluster role to use
*/}}
{{- define "trigger-v4.supervisorClusterRoleName" -}}
{{- default (printf "%s-supervisor-%s" (include "trigger-v4.fullname" .) .Release.Namespace) .Values.supervisor.rbac.clusterRole.name }}
{{- end }}

{{/*
Generate docker config for image pull secret
*/}}
{{- define "trigger-v4.imagePullSecret" }}
{{- if and .Values.registry.deploy .Values.registry.auth.enabled }}
{{- $registryHost := include "trigger-v4.registry.host" . }}
{{- $username := .Values.registry.auth.username }}
{{- $password := .Values.registry.auth.password }}
{{- $auth := printf "%s:%s" $username $password | b64enc }}
{{- $config := dict "auths" (dict $registryHost (dict "username" $username "password" $password "auth" $auth)) }}
{{- $config | toJson }}
{{- else if and (not .Values.registry.deploy) .Values.registry.external.auth.enabled }}
{{- $registryHost := .Values.registry.external.host }}
{{- $username := .Values.registry.external.auth.username }}
{{- $password := .Values.registry.external.auth.password }}
{{- $auth := printf "%s:%s" $username $password | b64enc }}
{{- $config := dict "auths" (dict $registryHost (dict "username" $username "password" $password "auth" $auth)) }}
{{- $config | toJson }}
{{- end }}
{{- end }}

{{/*
Merge ingress annotations to avoid duplicates
*/}}
{{- define "trigger-v4.ingress.annotations" -}}
{{- $annotations := dict -}}
{{- if .Values.ingress.annotations -}}
{{- $annotations = .Values.ingress.annotations -}}
{{- end -}}
{{- if .Values.ingress.certManager.enabled -}}
{{- $_ := set $annotations "cert-manager.io/cluster-issuer" .Values.ingress.certManager.clusterIssuer -}}
{{- end -}}
{{- if .Values.ingress.externalDns.enabled -}}
{{- $_ := set $annotations "external-dns.alpha.kubernetes.io/hostname" .Values.ingress.externalDns.hostname -}}
{{- $_ := set $annotations "external-dns.alpha.kubernetes.io/ttl" (.Values.ingress.externalDns.ttl | toString) -}}
{{- end -}}
{{- toYaml $annotations -}}
{{- end }}

