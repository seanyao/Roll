# CNX-OC (Cybernetix for OpenClaw)

Cybernetix 的 OpenClaw 适配层 - 将 CNX 工作流整合到 OpenClaw 生态。

## 这是什么？

`cnx-oc` 是 Cybernetix 的 **OpenClaw 专用变体**，提供：
- 统一的 `$cnx` 命令入口
- 与 OpenClaw agent 的无缝集成
- 简化的技能调用方式

## 目录结构

```
variants/cnx-oc/
├── README.md              # 本文件
├── skills/
│   └── cnx/               # OpenClaw skill
│       ├── SKILL.md       # 技能文档
│       └── cnx.sh         # 命令路由脚本
└── install.sh             # 安装脚本（可选）
```

## 安装到 OpenClaw

```bash
# 创建软链接（推荐）
ln -s ~/workspace/cybernetix/variants/cnx-oc/skills/cnx \
  ~/.openclaw/workspace/skills/cnx

# 同时链接 tools
ln -s ~/workspace/cybernetix/tools/cnx-fetch \
  ~/.openclaw/workspace/skills/cnx-fetch

ln -s ~/workspace/cybernetix/tools/cnx-probe \
  ~/.openclaw/workspace/skills/cnx-probe
```

## 使用

安装后，在 OpenClaw 的任何 agent 中都可以使用：

```bash
$cnx backlog "用户登录功能"     # 需求规划
$cnx build US-001               # 执行 Story
$cnx fetch https://example.com  # 网页抓取
$cnx probe find orin            # 节点发现
```

## 与上游同步

当 cybernetix 升级时，`cnx-oc` 自动获得更新：

```bash
cd ~/workspace/cybernetix
git pull origin main
# 完成！OpenClaw 自动使用新版本
```

## 版本锁定

如需锁定到特定版本：

```bash
cd ~/workspace/cybernetix
git checkout v1.2.3
```

## 差异说明

| 特性 | Cybernetix (原始) | CNX-OC (OpenClaw) |
|------|-------------------|-------------------|
| 调用方式 | 直接调用各 skill | `$cnx` 统一入口 |
| 工具名 | `cnx-fetch` | `cnx-fetch` |
| 工具名 | `cnx-probe` | `cnx-probe` |
| 集成 | 独立 CLI | OpenClaw 生态 |

## 维护

- **上游**: github.com/seanyao/cybernetix
- **问题反馈**: 在 cybernetix 仓库提交 issue
- **版本**: 跟随 cybernetix 主版本
