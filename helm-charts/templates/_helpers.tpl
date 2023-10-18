{{/*
Expand the name of the chart.
*/}}
{{- define "helm-charts.name" -}}
{{- default .Chart.Name .Values.trigger.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "helm-charts.fullname" -}}
{{- if .Values.trigger.fullnameOverride }}
{{- .Values.trigger.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.trigger.nameOverride }}
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
{{- define "helm-charts.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "helm-charts.labels" -}}
helm.sh/chart: {{ include "helm-charts.chart" . }}
{{ include "helm-charts.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "helm-charts.selectorLabels" -}}
app.kubernetes.io/name: {{ include "helm-charts.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "helm-charts.serviceAccountName" -}}
{{- if .Values.trigger.serviceAccount.create }}
{{- default (include "helm-charts.fullname" .) .Values.trigger.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.trigger.serviceAccount.name }}
{{- end }}
{{- end }}
