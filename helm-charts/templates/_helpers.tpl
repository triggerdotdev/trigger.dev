{{/*
Expand the name of the chart.
*/}}
{{- define "trigger.name" -}}
{{- default .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "trigger.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create unified labels for trigger components
*/}}
{{- define "trigger.common.matchLabels" -}}
app: {{ template "trigger.name" . }}
release: {{ .Release.Name }}
{{- end -}}

{{- define "trigger.common.metaLabels" -}}
chart: {{ template "trigger.chart" . }}
heritage: {{ .Release.Service }}
{{- end -}}

{{- define "trigger.common.labels" -}}
{{ include "trigger.common.matchLabels" . }}
{{ include "trigger.common.metaLabels" . }}
{{- end -}}

{{- define "trigger.labels" -}}
{{ include "trigger.matchLabels" . }}
{{ include "trigger.common.metaLabels" . }}
{{- end -}}

{{- define "trigger.matchLabels" -}}
component: {{ .Values.trigger.name | quote }}
{{ include "trigger.common.matchLabels" . }}
{{- end -}}


{{/*
Create the mongodb connection string.
*/}}
{{- define "trigger.postgresql.connectionString" -}}
{{- $host := "triggerdotdev" -}}
{{- $port := 5432 -}}
{{- $username := .Values.postgresql.global.postgresql.postgresqlUsername | default "postgres" -}}
{{- $password := .Values.postgresql.global.postgresql.postgresqlPassword | default "password" -}}
{{- $database := .Values.postgresql.global.postgresql.postgresqlDatabase | default "trigger" -}}
{{- $connectionString := printf "postgresql://%s:%s@%s:%d/%s" $username $password $host $port $database -}}
{{- printf "%s" $connectionString -}}
{{- end -}}