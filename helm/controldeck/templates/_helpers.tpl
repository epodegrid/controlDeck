{{- define "controldeck.fullname" -}}
{{- .Release.Name -}}
{{- end -}}

{{- define "controldeck.labels" -}}
app.kubernetes.io/part-of: controldeck
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
