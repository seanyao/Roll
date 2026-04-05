---
name: cnx-probe
description: Node discovery and health check for CNX environment. Find machines on LAN by name, check node health, verify OpenClaw Gateway status. Use when user asks to find a machine, check node status, diagnose gateway issues, or verify node connectivity.
---

# CNX Checker

**节点发现与健康检查工具** - 用于 CNX 环境的节点管理和状态诊断。

## Capabilities

1. **Node Discovery** - 局域网发现机器
   - 通过 Bonjour/mDNS 发现 SSH 服务
   - 解析 `.local` 主机名
   - 支持别名：orin, seanclaw, apeclaw

2. **Node Health Check** - 节点健康检查
   - OpenClaw Gateway 进程状态
   - 端口监听检查
   - 健康端点验证
   - 日志查看

## Usage

```bash
# 发现机器
$cnx-checker find <machine-name>

# 检查节点健康
$cnx-checker health <hostname>

# 完整诊断
$cnx-checker diagnose <machine-name>
```

## Node Discovery

使用 Bonjour `_ssh._tcp` 服务发现：

```bash
# 浏览所有 SSH 服务
dns-sd -B _ssh._tcp local

# 解析特定服务
dns-sd -L "Sean's Claw Machine" _ssh._tcp local
dns-sd -G v4v6 Seans-Claw-Machine.local
```

**已知别名**：
- `orin` / `nv-orin` → nv-orin.local
- `seanclaw` → Seans-Claw-Machine.local
- `apeclaw` → Ape's Claw Machine

## Health Check

针对 Orin/OpenClaw 主机的检查流程：

```bash
# 1. 身份确认
ssh -o BatchMode=yes -o ConnectTimeout=10 nvidia@nv-orin.local 'hostname && whoami'

# 2. 进程检查
ps -ef | grep -i "openclaw\|gateway" | grep -v grep

# 3. 端口检查
ss -ltnp | grep -E "18789|18791|18792"

# 4. 健康端点
for p in 18789 18791 18792; do
  curl -fsS http://127.0.0.1:$p/health || true
done
```

## Dynamic Host Resolution

优先顺序：
1. `nvidia@nv-orin.local` (Bonjour 主机名)
2. 当前 `.local` 主机名（通过发现）
3. 当前 IP（通过发现）

## References

- `scripts/find_ssh_machine.py` - SSH 机器发现脚本
