# Adding a New Agent Usage Plugin

5-step checklist for adding token/cost extraction for a new agent.

## 1. Create plugin file

```bash
cp lib/agent_usage/pi.py lib/agent_usage/<agent>.py
```

Implement `extract(stdin_lines: list[str]) -> dict | None`.

## 2. Register in `__init__.py`

In `lib/agent_usage/__init__.py`, add one entry to `_PLUGINS`:

```python
_PLUGINS = {
    "pi": ".pi",
    "<agent>": ".<agent>",  # ← add this line
}
```

The key must match `ROLL_LOOP_AGENT` env var (e.g. `kimi`, `deepseek`).

## 3. Capture sample output

Run a real cycle with the agent and save the stdout to a fixture:

```bash
roll loop go --max-cycles 1 2>&1 | tee tests/fixtures/<agent>_output_sample.txt
```

Or capture from a real cycle log.

## 4. Write unit tests

See `tests/unit/agent_usage_pi.bats` for reference. Test:
- Happy path: fixture produces valid dict (all required fields non-None)
- Edge case: empty lines, missing cost, unmatchable format → returns None
- Round-trip: known token counts match fixture

## 5. Run tests

```bash
npm test
```

That's it — no changes to `loop-fmt.py` or any other file.
