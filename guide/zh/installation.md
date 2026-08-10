# Roll — 安装与更新

## 安装

### curl（推荐）

```bash
npm install -g @seanyao/roll
```

仅需 bash 3.2+、curl、tar —— macOS 和 Linux 预装即可，无需 Node.js。

钉版本：

```bash
npm install -g @seanyao/roll
```

### npm

```bash
npm install -g @seanyao/roll
```

需要 Node.js 22+。

Roll 以 `@seanyao/roll` 发布。

macOS 上，npm 包会在 postinstall 中尽力从 `seanyao/roll-capture` 最新 GitHub
Release 下载 `Roll-Capture.app.zip`，校验后安装 `Roll Capture.app` 到
`~/Applications`。使用物理截图前，请打开一次应用并授予 Screen Recording 权限。
CI、headless、非 macOS、sudo/root shell、离线失败以及
`ROLL_SKIP_CAPTURE_INSTALL=1` 都会跳过 app 安装，且不会让 npm 安装失败。若 npm
是在 sudo/root 下运行，请再以普通用户跑 `roll setup` 安装，避免装进
`/var/root`。当前 Node runtime 暴露对应 fetch dispatcher 时，GitHub 下载请求会遵守
`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`。

无论哪种方式安装，完成后运行 setup 将约定和技能同步到你的 AI 工具：

```bash
roll setup
```

`roll setup --no-capture-install` 会禁止 setup 尝试同一套 Roll Capture.app 修复。
`roll doctor tools` 会报告 app、权限代理和 inbox 是否就绪。

## 验证

```bash
roll --version   # 显示已安装版本
roll status      # 显示路径和约定状态
```

## 更新

```bash
roll update
```

Roll 自动检测安装方式并对应处理：

| 安装方式 | `roll update` 的行为 |
|---|---|
| curl（默认） | 重新下载最新 tarball、原子替换，然后 `roll sync` |
| npm | `npm update -g @seanyao/roll`，然后 `roll sync` |
| git clone（贡献者） | 在包目录执行 `git pull`，然后 `roll sync` |

## 自动版本提示

每次 `roll` 命令结束后，后台静默查询 GitHub releases API（每 24 小时最多一次，缓存在 `~/.roll/.update-check`）。若有新版本，下一条命令结束时显示一行提示。检查完全异步，不影响命令速度。

## 卸载

### curl

```bash
rm -rf ~/.local/share/roll ~/.local/bin/roll
```

### npm

```bash
npm uninstall -g @seanyao/roll
```

不再需要时删除状态文件：

```bash
rm -rf ~/.roll ~/.shared/roll
```

## 另见

- [overview.md](overview.md) — roll 是什么
- [project-setup.md](project-setup.md) — 新项目的 `roll init`
- [configuration.md](configuration.md) — 环境变量
- [SECURITY.md](../../SECURITY.md) — curl|bash 信任边界与版本钉住
