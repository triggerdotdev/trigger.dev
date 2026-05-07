# Supervisor

Node.js app that manages task execution containers. Receives work from the platform, starts Docker/Kubernetes containers, monitors execution, and reports results.

## Key Directories

- `src/services/` - Core service logic
- `src/workloadManager/` - Container orchestration abstraction (Docker or Kubernetes)
- `src/workloadServer/` - HTTP server for workload communication (heartbeats, snapshots)
- `src/clients/` - Platform communication (webapp/coordinator)
- `src/env.ts` - Environment configuration

## Architecture

- **WorkloadManager**: Abstracts Docker vs Kubernetes execution
- **SupervisorSession**: Manages the dequeue loop with EWMA-based dynamic scaling
- **ResourceMonitor**: Tracks CPU/memory during execution
- **PodCleaner/FailedPodHandler**: Kubernetes-specific cleanup

Communicates with the platform via Socket.io and HTTP. Receives task assignments through the dequeue protocol from the webapp.
