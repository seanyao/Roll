# WK-OC (Wukong for OpenClaw)

OpenClaw adaptation layer for Wukong - Integrates the WK workflow into the OpenClaw ecosystem.

## What Is This?

`wk-oc` is the **OpenClaw-specific variant** of Wukong, providing:
- A unified `$wk` command entry point
- Seamless integration with the OpenClaw agent
- Simplified skill invocation

## Directory Structure

```
variants/wk-oc/
├── README.md              # This file
├── skills/
│   └── wk/                # OpenClaw skill
│       ├── SKILL.md       # Skill documentation
│       └── wk.sh          # Command routing script
└── install.sh             # Installation script (optional)
```

## Installing into OpenClaw

```bash
# Create symlinks (recommended)
ln -s ~/workspace/wukong/variants/wk-oc/skills/wk \
  ~/.openclaw/workspace/skills/wk

# Also link tools
ln -s ~/workspace/wukong/tools/wk-fetch \
  ~/.openclaw/workspace/skills/wk-fetch

ln -s ~/workspace/wukong/tools/wk-probe \
  ~/.openclaw/workspace/skills/wk-probe
```

## Usage

After installation, use in any OpenClaw agent:

```bash
$wk backlog "user login feature"     # Requirement planning
$wk build US-001                     # Execute Story
$wk fetch https://example.com        # Web scraping
$wk probe find orin                  # Node discovery
```

## Syncing with Upstream

When wukong is updated, `wk-oc` automatically gets the updates:

```bash
cd ~/workspace/wukong
git pull origin main
# Done! OpenClaw automatically uses the new version
```

## Version Pinning

To pin to a specific version:

```bash
cd ~/workspace/wukong
git checkout v1.2.3
```

## Differences

| Feature | Wukong (Original) | WK-OC (OpenClaw) |
|------|-------------------|-------------------|
| Invocation | Call individual skills directly | Unified `$wk` entry point |
| Tool name | `wk-fetch` | `wk-fetch` |
| Tool name | `wk-probe` | `wk-probe` |
| Integration | Standalone CLI | OpenClaw ecosystem |

## Maintenance

- **Upstream**: github.com/seanyao/wukong
- **Issue reporting**: Submit issues in the wukong repository
- **Version**: Follows wukong main version
