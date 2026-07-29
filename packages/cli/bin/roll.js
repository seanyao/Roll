#!/usr/bin/env node
// Roll v3 CLI entry — TS-first (US-SCAF-004).
import { dispatch, registerAll } from "../dist/index.js";

registerAll();

// US-LOOP-114: no wake hook. Nothing in a roll command arms a scheduler, because
// there is no scheduler — the session that runs `roll loop go` drives delivery.
const { status } = await dispatch(process.argv.slice(2));
process.exit(status);
