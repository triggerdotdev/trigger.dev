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
PostgreSQL connection string for internal PostgreSQL
*/}}
{{- define "trigger-v4.postgres.connectionString" -}}
{{- if .Values.postgres.external -}}
postgresql://{{ .Values.postgres.externalConnection.username }}:{{ .Values.postgres.externalConnection.password }}@{{ .Values.postgres.externalConnection.host }}:{{ .Values.postgres.externalConnection.port }}/{{ .Values.postgres.externalConnection.database }}?schema=public&sslmode=disable
{{- else -}}
postgresql://{{ .Values.postgres.auth.username }}:{{ .Values.postgres.auth.password }}@{{ include "trigger-v4.fullname" . }}-postgres:{{ .Values.postgres.primary.service.ports.postgres }}/{{ .Values.postgres.auth.database }}?schema=public&sslmode=disable
{{- end -}}
{{- end }}

{{/*
Redis connection details
*/}}
{{- define "trigger-v4.redis.host" -}}
{{- if .Values.redis.external -}}
{{ .Values.redis.externalConnection.host }}
{{- else -}}
{{ include "trigger-v4.fullname" . }}-redis-master
{{- end -}}
{{- end }}

{{- define "trigger-v4.redis.port" -}}
{{- if .Values.redis.external -}}
{{ .Values.redis.externalConnection.port }}
{{- else -}}
{{ .Values.redis.master.service.ports.redis }}
{{- end -}}
{{- end }}

{{/*
Electric service URL
*/}}
{{- define "trigger-v4.electric.url" -}}
{{- if .Values.electric.enabled -}}
http://{{ include "trigger-v4.fullname" . }}-electric:{{ .Values.electric.service.port }}
{{- else -}}
{{ .Values.config.electricOrigin }}
{{- end -}}
{{- end }}

{{/*
MinIO connection details
*/}}
{{- define "trigger-v4.minio.url" -}}
{{- if .Values.minio.enabled -}}
http://{{ include "trigger-v4.fullname" . }}-minio:{{ .Values.minio.service.ports.api }}
{{- else -}}
""
{{- end -}}
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
{{- if .Values.registry.external -}}
{{ .Values.registry.externalConnection.host }}:{{ .Values.registry.externalConnection.port }}
{{- else if .Values.registry.enabled -}}
{{ include "trigger-v4.fullname" . }}-registry:{{ .Values.registry.service.port }}
{{- else -}}
localhost:5000
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
{{- default (printf "%s-supervisor" (include "trigger-v4.fullname" .)) .Values.supervisor.rbac.clusterRole.name }}
{{- end }}

{{/*
Generate docker config for image pull secret
*/}}
{{- define "trigger-v4.imagePullSecret" }}
{{- if and .Values.registry.enabled .Values.registry.auth.enabled }}
{{- $registryHost := include "trigger-v4.registry.host" . }}
{{- $username := .Values.registry.auth.username }}
{{- $password := .Values.registry.auth.password }}
{{- $auth := printf "%s:%s" $username $password | b64enc }}
{{- $config := dict "auths" (dict $registryHost (dict "username" $username "password" $password "auth" $auth)) }}
{{- $config | toJson }}
{{- else if and .Values.registry.external .Values.registry.externalConnection.auth.enabled }}
{{- $registryHost := .Values.registry.externalConnection.host }}
{{- $username := .Values.registry.externalConnection.auth.username }}
{{- $password := .Values.registry.externalConnection.auth.password }}
{{- $auth := printf "%s:%s" $username $password | b64enc }}
{{- $config := dict "auths" (dict $registryHost (dict "username" $username "password" $password "auth" $auth)) }}
{{- $config | toJson }}
{{- end }}
{{- end }}

