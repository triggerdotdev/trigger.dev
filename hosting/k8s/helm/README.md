# Trigger.dev v4 Helm Chart

This Helm chart deploys Trigger.dev v4 self-hosting stack to Kubernetes.

## Quick Start

### Installation

```bash
# Deploy with default values (testing/development only)
helm install trigger .

# Deploy to specific namespace
helm install trigger . -n trigger --create-namespace

# Deploy with custom values for production
helm install trigger . -f values-production.yaml -n trigger --create-namespace
```

### Upgrading

```bash
# Upgrade existing release
helm upgrade trigger .

# Upgrade with new values
helm upgrade trigger . -f values-production.yaml
```

### Access the dashboard

```bash
kubectl port-forward svc/trigger-webapp 3040:3030 --address 0.0.0.0
```

Dashboard: http://localhost:3040/

### Deploying your tasks

```bash
# The --push arg is required when testing locally
npx trigger.dev@v4-beta deploy --push
```

## ⚠️ Security Requirements

### Secrets Configuration

**IMPORTANT**: The default secrets are for **TESTING ONLY** and must be changed for production.

#### Required Secrets

All secrets must be exactly **32 hexadecimal characters** (16 bytes):

- `sessionSecret` - User authentication sessions
- `magicLinkSecret` - Passwordless login tokens  
- `encryptionKey` - Sensitive data encryption
- `managedWorkerSecret` - Worker authentication

#### Generate Production Secrets

```bash
for i in {1..4}; do openssl rand -hex 16; done
```

#### Configure Production Secrets

```yaml
# values-production.yaml
secrets:
  sessionSecret: "your-generated-secret-1"
  magicLinkSecret: "your-generated-secret-2" 
  encryptionKey: "your-generated-secret-3"
  managedWorkerSecret: "your-generated-secret-4"
  objectStore:
    accessKeyId: "your-s3-access-key"
    secretAccessKey: "your-s3-secret-key"
```

## Architecture

This chart deploys the following components:

### Core Services
- **Webapp** - Main Trigger.dev application (port 3030)
- **PostgreSQL** - Primary database with logical replication  
- **Redis** - Cache and job queue
- **Electric** - Real-time sync service (ElectricSQL)

### Worker Services
- **Supervisor** - Kubernetes worker orchestrator for executing runs

### Supporting Services  
- **ClickHouse** - Analytics database
- **MinIO** - S3-compatible object storage
- **Registry** - Private Docker registry for deployed code (EXPERIMENTAL - disabled by default)

## Configuration

### Basic Configuration

```yaml
# Application URLs
config:
  appOrigin: "https://trigger.example.com"
  loginOrigin: "https://trigger.example.com" 
  apiOrigin: "https://trigger.example.com"

# Bootstrap mode (auto-creates worker group)
config:
  bootstrap:
    enabled: true  # Enable for combined setups
    workerGroupName: "bootstrap"
```

### External Services

Use external managed services instead of bundled components:

```yaml
# External PostgreSQL
postgresql:
  enabled: false
  external: true
  externalConnection:
    host: "your-postgres.rds.amazonaws.com"
    port: 5432
    database: "trigger"
    username: "trigger_user"
    password: "your-password"

# External Redis  
redis:
  enabled: false
  external: true
  externalConnection:
    host: "your-redis.cache.amazonaws.com"
    port: 6379
    password: "your-password"

# External Docker Registry (e.g., Kind local registry)
registry:
  enabled: true
  external: true
  externalConnection:
    host: "localhost"
    port: 5001
    username: ""
    password: ""
```

### Ingress Configuration

```yaml
ingress:
  enabled: true
  className: "nginx"
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
  hosts:
    - host: trigger.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: trigger-tls
      hosts:
        - trigger.example.com
```

### Resource Configuration

```yaml
resources:
  webapp:
    limits:
      cpu: 2000m
      memory: 4Gi
    requests:
      cpu: 1000m
      memory: 2Gi

postgresql:
  primary:
    resources:
      limits:
        cpu: 1000m
        memory: 2Gi
```

## Deployment Modes

### Testing/Development
- Use default values
- Single replica
- Lower resource limits
- Bootstrap mode enabled

### Production  
- Custom secrets (required)
- Multiple replicas with anti-affinity
- Production resource limits
- External services recommended
- Ingress with TLS
- Persistent storage

## Persistence

All services support persistent storage and allow you to control the storage class globally or per service:

```yaml
global:
  storageClass: "fast-ssd" # Default for all services

postgresql:
  primary:
    persistence:
      enabled: true
      size: 10Gi
      storageClass: "postgres-nvme" # Optional: override for PostgreSQL

redis:
  master:
    persistence:
      enabled: true
      size: 5Gi
      storageClass: "redis-ssd" # Optional: override for Redis

clickhouse:
  persistence:
    enabled: true
    size: 10Gi
    storageClass: "analytics-hdd" # Optional: override for ClickHouse

minio:
  persistence:
    enabled: true
    size: 10Gi
    storageClass: "objectstore-ssd" # Optional: override for MinIO

registry:
  persistence:
    enabled: true
    size: 10Gi
    storageClass: "registry-ssd" # Optional: override for Registry

# Shared persistent volume for worker token file
persistence:
  shared:
    enabled: true
    size: 5Mi
```

- If a per-service `storageClass` is set, it overrides the global value for that service only.
- If neither is set, the cluster's default StorageClass is used.

## Monitoring

### Health Checks

Health checks are configured for all services:
- HTTP endpoints for web services
- Database connection tests
- Readiness and liveness probes

### Prometheus Integration

ServiceMonitors are available for webapp and supervisor services:

```yaml
webapp:
  serviceMonitor:
    enabled: true
    interval: "30s"
    path: "/metrics"
    labels:
      release: prometheus-stack

supervisor:
  serviceMonitor:
    enabled: true
    interval: "30s"
    path: "/metrics"
    labels:
      release: prometheus-stack
```

## Operations

### Force Pod Restart

When you need to force all pods to restart (e.g., to pick up updated secrets or config):

```bash
# Force restart using timestamp annotation (Helm-native approach)
helm upgrade <release-name> . --set-string podAnnotations.restartedAt="$(date +%s)"

# Example
helm upgrade trigger . --set-string podAnnotations.restartedAt="$(date +%s)"
```

This approach:
- ✅ Uses Helm's built-in annotation mechanism
- ✅ Safe - doesn't recreate immutable resources like PVCs
- ✅ Targeted - only restarts pods that need updates
- ✅ Trackable - increments Helm revision number

### Configuration Updates

After changing secrets or ConfigMaps in your values file:

```bash
# 1. Upgrade with new values
helm upgrade trigger . -f values-production.yaml

# 2. Force pod restart to pick up changes
helm upgrade trigger . -f values-production.yaml \
  --set-string podAnnotations.restartedAt="$(date +%s)"
```

## Troubleshooting

### Check Pod Status
```bash
kubectl get pods -l app.kubernetes.io/name=trigger.dev
```

### View Logs
```bash
# Webapp logs
kubectl logs -l app.kubernetes.io/component=webapp

# Database logs  
kubectl logs -l app.kubernetes.io/component=postgresql
```

### Run Tests
```bash
helm test trigger.dev
```

## Testing

### Validate Deployment

```bash
# Check Helm template syntax
helm template trigger.dev . --dry-run > /dev/null && echo "Template validation successful"

# Test webapp health endpoint (requires port forwarding)
curl -s -o /dev/null -w "%{http_code}" http://localhost:3040/healthcheck || echo "Connection failed"

# Port forward to access webapp locally
kubectl port-forward svc/trigger.dev-webapp 3040:3030 --address 0.0.0.0
```

### Common Issues

1. **Secrets errors**: Ensure all secrets are exactly 32 hex characters
2. **Database connection**: Check PostgreSQL is ready before webapp starts
3. **Resource limits**: Increase limits for ClickHouse in constrained environments
4. **Config not applying**: Use the pod restart technique above to force config reload
5. **Image pull errors**: When testing locally, deploy with `npx trigger.dev@v4-beta deploy --push`

## Examples

See `values-production-example.yaml` for a complete production configuration example.

## Version Management

### Understanding Versions

The Helm chart uses three types of versions:

1. **Chart Version** (`Chart.yaml:version`) - Helm chart packaging version
2. **App Version** (`Chart.yaml:appVersion`) - Trigger.dev application version  
3. **Component Versions** (`values.yaml`) - Individual service versions (Electric, ClickHouse, etc.)

### Release Process

#### For Chart Maintainers

1. **Update Chart Version** for chart changes:
   ```bash
   # Edit Chart.yaml
   version: 4.1.0  # Increment for chart changes (semver)
   ```

2. **Update App Version** when Trigger.dev releases new version:
   ```bash
   # Edit Chart.yaml  
   appVersion: "v4.1.0"  # Match Trigger.dev release (v-prefixed image tag)
   ```

3. **Release via GitHub**:
   ```bash
   # Tag and push
   git tag helm-v4.1.0
   git push origin helm-v4.1.0
   
   # GitHub Actions will automatically build and publish to GHCR
   ```

#### For Users

```bash
# Install specific chart version
helm upgrade --install trigger \
  oci://ghcr.io/triggerdotdev/charts/trigger.dev \
  --version 4.1.0

# Install latest chart version
helm upgrade --install trigger \
  oci://ghcr.io/triggerdotdev/charts/trigger.dev

# Override app version (advanced)
helm upgrade --install trigger . \
  --set webapp.image.tag=v4.0.1
```

## Production Readiness Checklist

### 🔒 Security (REQUIRED)

- [ ] **Generate unique secrets** (never use defaults):
  ```bash
  # Generate 4 secrets
  for i in {1..4}; do openssl rand -hex 16; done
  ```

- [ ] **Configure security contexts**:
  ```yaml
  webapp:
    podSecurityContext:
      fsGroup: 1000
    securityContext:
      runAsNonRoot: true
      runAsUser: 1000
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: [ALL]
  ```

- [ ] **Enable network policies** (if supported by cluster)
- [ ] **Configure proper RBAC** for supervisor
- [ ] **Use TLS ingress** with cert-manager

### 📊 Resource Management (REQUIRED)

- [ ] **Set resource limits and requests** - for example:
  ```yaml
  webapp:
    resources:
      limits:
        cpu: 2000m
        memory: 4Gi
      requests:
        cpu: 1000m
        memory: 2Gi
  
  postgresql:
    primary:
      resources:
        limits:
          cpu: 1000m
          memory: 2Gi
        requests:
          cpu: 500m
          memory: 1Gi
  
  redis:
    master:
      resources:
        limits:
          cpu: 500m
          memory: 1Gi
        requests:
          cpu: 250m
          memory: 512Mi
  
  clickhouse:
    resources:
      limits:
        cpu: 1000m
        memory: 2Gi
      requests:
        cpu: 500m
        memory: 1Gi
  
  supervisor:
    resources:
      limits:
        cpu: 500m
        memory: 1Gi
      requests:
        cpu: 250m
        memory: 512Mi
  ```

- [ ] **Configure persistent storage for all services** - for example:
  ```yaml
  global:
    storageClass: "fast-nvme" # Default for all services

  postgresql:
    persistence:
      primary:
        size: 500Gi

  redis:
    persistence:
      master:
        size: 20Gi

  clickhouse:
    persistence:
      size: 100Gi

  minio:
    persistence:
      size: 200Gi

  registry:
    persistence:
      size: 100Gi
  ```

### 🏗️ High Availability (RECOMMENDED)

- [ ] **Multiple replicas** with pod anti-affinity
- [ ] **Pod disruption budgets**
- [ ] **External managed services** (RDS, ElastiCache, etc.)
- [ ] **Multi-AZ storage classes**
- [ ] **Backup strategies** for databases

### 📈 Monitoring (RECOMMENDED)

- [ ] **Enable ServiceMonitors** for Prometheus
- [ ] **Configure alerting** for critical services
- [ ] **Set up log aggregation**
- [ ] **Monitor resource usage** and adjust limits

### 🚀 Performance (OPTIONAL)

- [ ] **Horizontal Pod Autoscaler** for webapp
- [ ] **Vertical Pod Autoscaler** for data services
- [ ] **Node affinity** for data services
- [ ] **Separate storage classes** for different workloads

## Support

- Documentation: https://trigger.dev/docs/self-hosting
- GitHub Issues: https://github.com/triggerdotdev/trigger.dev/issues