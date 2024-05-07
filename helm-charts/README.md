# Trigger.dev Helm Chart

> WARNING: Kubernetes deploys are not officially supported yet, please only use these instructions as a general guide and starting point.

## Installation

As our charts aren't published for official use yet, you'll need a copy of the `helm-charts` dir and run the following commands within it:

```bash
# with access to your cluster, e.g. KUBECONFIG correctly set
helm upgrade --install --atomic --namespace trigger --create-namespace trigger .

# watch the deployment
kubectl --namespace trigger get deployments -w
```

## Parameters

### Common parameters

| Name               | Description               | Value |
| ------------------ | ------------------------- | ----- |
| `nameOverride`     | Override release name     | `""`  |
| `fullnameOverride` | Override release fullname | `""`  |

### Trigger.dev parameters

| Name                              | Description                                                                                                     | Value                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `trigger.name`                    |                                                                                                                 | `trigger`                           |
| `trigger.fullnameOverride`        | trigger fullnameOverride                                                                                        | `""`                                |
| `trigger.podAnnotations`          | trigger pod annotations                                                                                         | `{}`                                |
| `trigger.deploymentAnnotations`   | trigger deployment annotations                                                                                  | `{}`                                |
| `trigger.replicaCount`            | trigger replica count                                                                                           | `2`                                 |
| `trigger.image.repository`        | trigger image repository                                                                                        | `ghcr.io/triggerdotdev/trigger.dev` |
| `trigger.image.tag`               | trigger image tag                                                                                               | `latest`                            |
| `trigger.image.pullPolicy`        | trigger image pullPolicy                                                                                        | `Always`                            |
| `trigger.resources.limits.memory` | container memory limit [(docs)](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/) | `800Mi`                             |
| `trigger.resources.requests.cpu`  | container CPU requests [(docs)](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/) | `250m`                              |
| `trigger.affinity`                | Backend pod affinity                                                                                            | `{}`                                |
| `trigger.kubeSecretRef`           | trigger secret resource reference name                                                                          | `""`                                |
| `trigger.service.annotations`     | trigger service annotations                                                                                     | `{}`                                |
| `trigger.service.type`            | trigger service type                                                                                            | `ClusterIP`                         |
| `trigger.service.nodePort`        | trigger service nodePort (used if above type is `NodePort`)                                                     | `""`                                |

### Postgres parameters

| Name                                                                  | Description                                                                                                                                                                                      | Value                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `postgresql.enabled`                                                  | Enable Postgres                                                                                                                                                                                  | `true`                     |
| `postgresql.name`                                                     | Name used to build variables (deprecated)                                                                                                                                                        | `postgresql`               |
| `postgresql.nameOverride`                                             | Name override                                                                                                                                                                                    | `postgresql`               |
| `postgresql.fullnameOverride`                                         | Fullname override                                                                                                                                                                                | `postgresql`               |
| `postgresql.global.postgresql.auth.postgresPassword`                  | Password for the "postgres" admin user (overrides `auth.postgresPassword`)                                                                                                                       | `password`                 |
| `postgresql.global.postgresql.auth.username`                          | Name for a custom user to create (overrides `auth.username`)                                                                                                                                     | `postgres`                 |
| `postgresql.global.postgresql.auth.password`                          | Password for the custom user to create (overrides `auth.password`)                                                                                                                               | `password`                 |
| `postgresql.global.postgresql.auth.database`                          | Name for a custom database to create (overrides `auth.database`)                                                                                                                                 | `trigger`                  |
| `postgresql.global.postgresql.auth.existingSecret`                    | Name of existing secret to use for PostgreSQL credentials (overrides `auth.existingSecret`).                                                                                                     | `""`                       |
| `postgresql.global.postgresql.auth.secretKeys.adminPasswordKey`       | Name of key in existing secret to use for PostgreSQL credentials (overrides `auth.secretKeys.adminPasswordKey`). Only used when `postgresql.global.postgresql.auth.existingSecret` is set.       | `""`                       |
| `postgresql.global.postgresql.auth.secretKeys.userPasswordKey`        | Name of key in existing secret to use for PostgreSQL credentials (overrides `auth.secretKeys.userPasswordKey`). Only used when `postgresql.global.postgresql.auth.existingSecret` is set.        | `""`                       |
| `postgresql.global.postgresql.auth.secretKeys.replicationPasswordKey` | Name of key in existing secret to use for PostgreSQL credentials (overrides `auth.secretKeys.replicationPasswordKey`). Only used when `postgresql.global.postgresql.auth.existingSecret` is set. | `""`                       |
| `postgresql.global.postgresql.service.ports.postgresql`               | PostgreSQL service port (overrides `service.ports.postgresql`)                                                                                                                                   | `5432`                     |
| `postgresql.image.registry`                                           | PostgreSQL image registry                                                                                                                                                                        | `docker.io`                |
| `postgresql.image.repository`                                         | PostgreSQL image repository                                                                                                                                                                      | `bitnami/postgresql`       |
| `postgresql.image.tag`                                                | PostgreSQL image tag (immutable tags are recommended)                                                                                                                                            | `14.10.0-debian-11-r21`    |
| `postgresql.image.digest`                                             | PostgreSQL image digest in the way sha256:aa.... Please note this parameter, if set, will override the tag                                                                                       | `""`                       |
| `postgresql.image.pullPolicy`                                         | PostgreSQL image pull policy                                                                                                                                                                     | `IfNotPresent`             |
| `postgresql.image.pullSecrets`                                        | Specify image pull secrets                                                                                                                                                                       | `[]`                       |
| `postgresql.image.debug`                                              | Specify if debug values should be set                                                                                                                                                            | `false`                    |
| `postgresql.architecture`                                             | PostgreSQL architecture (`standalone` or `replication`)                                                                                                                                          | `standalone`               |
| `postgresql.containerPorts.postgresql`                                | PostgreSQL container port                                                                                                                                                                        | `5432`                     |
| `postgresql.postgresqlDataDir`                                        | PostgreSQL data dir                                                                                                                                                                              | `/bitnami/postgresql/data` |
| `postgresql.postgresqlSharedPreloadLibraries`                         | Shared preload libraries (comma-separated list)                                                                                                                                                  | `pgaudit`                  |

### PostgreSQL Primary parameters

| Name                                                    | Description                                            | Value               |
| ------------------------------------------------------- | ------------------------------------------------------ | ------------------- |
| `postgresql.primary.livenessProbe.enabled`              | Enable livenessProbe on PostgreSQL Primary containers  | `true`              |
| `postgresql.primary.livenessProbe.initialDelaySeconds`  | Initial delay seconds for livenessProbe                | `30`                |
| `postgresql.primary.livenessProbe.periodSeconds`        | Period seconds for livenessProbe                       | `10`                |
| `postgresql.primary.livenessProbe.timeoutSeconds`       | Timeout seconds for livenessProbe                      | `5`                 |
| `postgresql.primary.livenessProbe.failureThreshold`     | Failure threshold for livenessProbe                    | `6`                 |
| `postgresql.primary.livenessProbe.successThreshold`     | Success threshold for livenessProbe                    | `1`                 |
| `postgresql.primary.readinessProbe.enabled`             | Enable readinessProbe on PostgreSQL Primary containers | `true`              |
| `postgresql.primary.readinessProbe.initialDelaySeconds` | Initial delay seconds for readinessProbe               | `5`                 |
| `postgresql.primary.readinessProbe.periodSeconds`       | Period seconds for readinessProbe                      | `10`                |
| `postgresql.primary.readinessProbe.timeoutSeconds`      | Timeout seconds for readinessProbe                     | `5`                 |
| `postgresql.primary.readinessProbe.failureThreshold`    | Failure threshold for readinessProbe                   | `6`                 |
| `postgresql.primary.readinessProbe.successThreshold`    | Success threshold for readinessProbe                   | `1`                 |
| `postgresql.primary.startupProbe.enabled`               | Enable startupProbe on PostgreSQL Primary containers   | `false`             |
| `postgresql.primary.startupProbe.initialDelaySeconds`   | Initial delay seconds for startupProbe                 | `30`                |
| `postgresql.primary.startupProbe.periodSeconds`         | Period seconds for startupProbe                        | `10`                |
| `postgresql.primary.startupProbe.timeoutSeconds`        | Timeout seconds for startupProbe                       | `1`                 |
| `postgresql.primary.startupProbe.failureThreshold`      | Failure threshold for startupProbe                     | `15`                |
| `postgresql.primary.startupProbe.successThreshold`      | Success threshold for startupProbe                     | `1`                 |
| `postgresql.primary.persistence.enabled`                | Enable PostgreSQL Primary data persistence using PVC   | `true`              |
| `postgresql.primary.persistence.existingClaim`          | Name of an existing PVC to use                         | `""`                |
| `postgresql.primary.persistence.accessModes`            | PVC Access Mode for PostgreSQL volume                  | `["ReadWriteOnce"]` |
| `postgresql.primary.persistence.size`                   | PVC Storage Request for PostgreSQL volume              | `8Gi`               |

### Ingress parameters

| Name                       | Description                                                              | Value    |
| -------------------------- | ------------------------------------------------------------------------ | -------- |
| `ingress.enabled`          | Enable ingress                                                           | `true`   |
| `ingress.ingressClassName` | Ingress class name                                                       | `nginx`  |
| `ingress.nginx.enabled`    | Ingress controller                                                       | `false`  |
| `ingress.annotations`      | Ingress annotations                                                      | `{}`     |
| `ingress.hostName`         | Ingress hostname (your custom domain name, e.g. `infisical.example.org`) | `""`     |
| `ingress.tls`              | Ingress TLS hosts (matching above hostName)                              | `[]`     |
| `ingress.trigger.path`     | Trigger.dev ingress path                                                 | `/`      |
| `ingress.trigger.pathType` | Trigger.dev ingress path type                                            | `Prefix` |

## Generating docs

This chart aims to be compliant with the [Readme Generator For Helm](https://github.com/bitnami/readme-generator-for-helm) to easily create and maintain the parameters tables above.

To update the docs, just run: `pnpm generate-docs`
