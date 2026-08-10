# Roll — Installation & Updates

## Install

### curl (recommended)

```bash
npm install -g @bipo-ape/roll
```

No prerequisites beyond bash 3.2+, curl, and tar — all preinstalled on macOS and Linux.

To pin a specific version:

```bash
npm install -g @bipo-ape/roll
```

### npm

```bash
npm install -g @bipo-ape/roll
```

Requires Node.js 22+.

Roll is published under two equivalent names: `@bipo-ape/roll` (use this) and
`@seanyao/roll` (the original scope, kept working for existing installs). Both
ship the identical artifact at the same version — installing or updating from
either gets you the same `roll`.

On macOS, the npm package runs a best-effort postinstall that downloads
`Roll-Capture.app.zip` from the latest `seanyao/roll-capture` GitHub Release,
validates the asset, and installs `Roll Capture.app` into `~/Applications`.
Open the app once and grant Screen Recording permission before relying on
physical screenshots. CI, headless sessions, non-macOS hosts, offline failures,
sudo/root shells, and `ROLL_SKIP_CAPTURE_INSTALL=1` skip the app install without
failing npm. If npm ran under sudo/root, run `roll setup` again as a regular user
so Roll installs the app into that user's `~/Applications`, not `/var/root`.
GitHub download requests respect `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` when the
current Node runtime exposes the matching fetch dispatcher.

After installation via either method, run setup to sync conventions and skills into your AI tools:

```bash
roll setup
```

`roll setup --no-capture-install` keeps setup from attempting the same Roll
Capture.app repair. `roll doctor tools` reports whether the app, permission
proxy, and inbox are ready.

## Verify

```bash
roll --version   # print installed version
roll status      # show resolved paths and convention state
```

## Update

```bash
roll update
```

Roll detects how it was installed and acts accordingly:

| Install mode | What `roll update` does |
|---|---|
| curl (default) | Re-downloads the latest tarball, extracts atomically, then `roll sync` |
| npm | `npm update -g @bipo-ape/roll`, then `roll sync` |
| git clone (contributors) | `git pull` in the package directory, then `roll sync` |

## Automatic Version Nudge

After each `roll` command, a background check queries the GitHub releases API
(at most once per 24 h, cached at `~/.roll/.update-check`). If a newer version
is available, a one-line nudge appears at the end of the next command's output.
The check is fire-and-forget — it never delays your command.

## Uninstall

### curl

```bash
rm -rf ~/.local/share/roll ~/.local/bin/roll
```

### npm

```bash
npm uninstall -g @bipo-ape/roll
```

Remove state files afterward if you no longer need them:

```bash
rm -rf ~/.roll ~/.shared/roll
```

## See Also

- [overview.md](overview.md) — what roll is
- [project-setup.md](project-setup.md) — `roll init` for a new project
- [configuration.md](configuration.md) — environment variables
- [SECURITY.md](../../SECURITY.md) — curl|bash trust boundary and version pinning
