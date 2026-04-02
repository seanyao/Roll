# Project Agents Configuration

## PDCA Workflow

### Plan → $cnx-backlog
- 需求分析、方案设计
- 拆分 Stories
- 写入 BACKLOG.md

### Do → $cnx-story-build / $cnx-fix-build / $cnx-roll-build
- 读取 BACKLOG 执行
- TCR 开发
- CI/CD 部署

### Check → $cnx-sentinel / $cnx-bb-debug
- Sentinel: 定时巡检
- cnx-bb-debug: 深度诊断

### Act → $cnx-fix-build / $cnx-backlog
- 修复问题
- 或重新规划

## Architecture Constraints

### Agent First
- 系统为 AI Agent 设计
- Agent 是第一用户
- UI 只是辅助界面

### Data Schema
- 清晰的数据结构定义
- Type/Schema 是人与 Agent 的契约
- 先定义 Schema，再写业务逻辑

### Domain Driven
- 按业务领域建模
- 非数据库表设计
- 帮助 Agent 理解业务

### Decoupling Rules
- UI 层只负责渲染，逻辑在 Hooks
- API 调用封装在 services/
- 共享类型放在 shared/types/

### Testing Requirements
- 所有业务逻辑必须有单元测试
- API 有集成测试
- 关键流程有 E2E 测试
- Sentinel 会定期回归测试

## Conventions

- All work tracked in BACKLOG.md
- Sentinel patrols every 6 hours
- TCR required for all changes
