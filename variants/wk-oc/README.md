# CNX-OC (Cybernetix for OpenClaw)

OpenClaw adaptation layer for Cybernetix - Integrates the CNX workflow into the OpenClaw ecosystem.

## What Is This?

`wk-oc` is the **OpenClaw-specific variant** of Cybernetix, providing:
- A unified `$cnx` command entry point
- Seamless integration with the OpenClaw agent
- Simplified skill invocation

## Directory Structure

```
variants/wk-oc/
├── README.md              # This file
├── skills/
│   └── cnx/               # OpenClaw skill
│       ├── SKILL.md       # Skill documentation
│       └── cnx.sh         # Command routing script
└── install.sh             # Installation script (optional)
```

## Installing into OpenClaw

```bash
# Create symlinks (recommended)
ln -s ~/workspace/wukong/variants/wk-oc/skills/cnx \
  ~/.openclaw/workspace/skills/cnx

# Also link tools
ln -s ~/workspace/wukong/tools/wk-fetch \
  ~/.openclaw/workspace/skills/wk-fetch

ln -s ~/workspace/wukong/tools/wk-probe \
  ~/.openclaw/workspace/skills/wk-probe
```

## Usage

After installation, use in any OpenClaw agent:

```bash
$cnx backlog "user login feature"     # Requirement planning
$cnx build US-001                     # Execute Story
$cnx fetch https://example.com        # Web scraping
$cnx probe find orin                  # Node discovery
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

| Feature | Cybernetix (Original) | CNX-OC (OpenClaw) |
|------|-------------------|-------------------|
| Invocation | Call individual skills directly | Unified `$cnx` entry point |
| Tool name | `wk-fetch` | `wk-fetch` |
| Tool name | `wk-probe` | `wk-probe` |
| Integration | Standalone CLI | OpenClaw ecosystem |

## Maintenance

- **Upstream**: github.com/seanyao/wukong
- **Issue reporting**: Submit issues in the wukong repository
- **Version**: Follows wukong main version
