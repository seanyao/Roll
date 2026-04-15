---
hidden: true
name: wk-probe
description: Node discovery and health check for CNX environment. Find machines on LAN by name, check node health, verify OpenClaw Gateway status. Use when user asks to find a machine, check node status, diagnose gateway issues, or verify node connectivity.
---

# CNX Checker

**Node discovery and health check tool** - for node management and status diagnosis in CNX environments.

## Capabilities

1. **Node Discovery** - Discover machines on LAN
   - Discover SSH services via Bonjour/mDNS
   - Resolve `.local` hostnames
   - Supports aliases: orin, seanclaw, apeclaw

2. **Node Health Check** - Check node health
   - OpenClaw Gateway process status
   - Port listening check
   - Health endpoint verification
   - Log viewing

## Usage

```bash
# Discover machines
$wk-checker find <machine-name>

# Check node health
$wk-checker health <hostname>

# Full diagnosis
$wk-checker diagnose <machine-name>
```

## Node Discovery

Uses Bonjour `_ssh._tcp` service discovery:

```bash
# Browse all SSH services
dns-sd -B _ssh._tcp local

# Resolve a specific service
dns-sd -L "Sean's Claw Machine" _ssh._tcp local
dns-sd -G v4v6 Seans-Claw-Machine.local
```

**Known aliases**:
- `orin` / `nv-orin` → nv-orin.local
- `seanclaw` → Seans-Claw-Machine.local
- `apeclaw` → Ape's Claw Machine

## Health Check

Check procedure for Orin/OpenClaw hosts:

```bash
# 1. Identity verification
ssh -o BatchMode=yes -o ConnectTimeout=10 nvidia@nv-orin.local 'hostname && whoami'

# 2. Process check
ps -ef | grep -i "openclaw\|gateway" | grep -v grep

# 3. Port check
ss -ltnp | grep -E "18789|18791|18792"

# 4. Health endpoint
for p in 18789 18791 18792; do
  curl -fsS http://127.0.0.1:$p/health || true
done
```

## Dynamic Host Resolution

Priority order:
1. `nvidia@nv-orin.local` (Bonjour hostname)
2. Current `.local` hostname (via discovery)
3. Current IP (via discovery)

## References

- `scripts/find_ssh_machine.py` - SSH machine discovery script
