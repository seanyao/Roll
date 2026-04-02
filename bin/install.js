#!/usr/bin/env node

/**
 * Post-install script for Cybernetix
 * Sets up skill symlinks for Kimi CLI / Codex CLI
 */

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync, existsSync, mkdirSync, symlinkSync, readdirSync } from 'fs';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

console.log(`\n🚀 Setting up Cybernetix v${pkg.version}...\n`);

// 可能的 skill 目录路径
const POSSIBLE_SKILL_PATHS = [
  join(homedir(), '.codex', 'skills'),
  join(homedir(), '.kimi', 'skills'),
  join(homedir(), '.claude', 'skills'),
];

const skillsSourceDir = join(__dirname, '..', 'skills');

function setupSkills(skillDir) {
  if (!existsSync(skillDir)) {
    try {
      mkdirSync(skillDir, { recursive: true });
      console.log(`📁 Created: ${skillDir}`);
    } catch (err) {
      console.error(`❌ Failed to create ${skillDir}: ${err.message}`);
      return false;
    }
  }

  const skills = readdirSync(skillsSourceDir).filter(f => 
    existsSync(join(skillsSourceDir, f, 'SKILL.md'))
  );

  let linked = 0;
  for (const skill of skills) {
    const source = join(skillsSourceDir, skill);
    const target = join(skillDir, skill);

    try {
      if (existsSync(target)) {
        console.log(`  ⏭️  Skipped: ${skill} (already exists)`);
      } else {
        symlinkSync(source, target);
        console.log(`  ✅ Linked: ${skill}`);
        linked++;
      }
    } catch (err) {
      console.error(`  ❌ Failed to link ${skill}: ${err.message}`);
    }
  }

  return linked;
}

console.log('📦 Skills source:', skillsSourceDir);
console.log('');

let totalLinked = 0;
for (const skillPath of POSSIBLE_SKILL_PATHS) {
  console.log(`🔍 Checking: ${skillPath}`);
  const linked = setupSkills(skillPath);
  if (linked > 0) {
    totalLinked += linked;
  }
}

console.log('');
console.log('═══════════════════════════════════════════════════');
console.log('');
console.log('🎉 Cybernetix setup complete!');
console.log('');
console.log('   Use skills in your AI coding environment:');
console.log('   $cnx-backlog "your requirement"');
console.log('   $cnx-story-build US-001');
console.log('   $cnx-sentinel patrol');
console.log('');
console.log('   Learn more: cnx --help');
console.log('');
console.log('═══════════════════════════════════════════════════');
console.log('');
