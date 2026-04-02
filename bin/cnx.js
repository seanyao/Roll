#!/usr/bin/env node

/**
 * Cybernetix (CNX) CLI
 * 
 * The AI-Native Development Paradigm
 * Control Theory + Agent First + PDCA
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 版本信息
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

// Logo
const LOGO = `
╔═══════════════════════════════════════════════════════════════════════════════════════════╗
║                                                                                           ║
║       ██████╗██╗   ██╗██████╗ ███████╗██████╗ ███╗   ██╗███████╗████████╗██╗██╗  ██╗      ║
║      ██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗████╗  ██║██╔════╝╚══██╔══╝██║╚██╗██╔╝      ║
║      ██║      ╚████╔╝ ██████╔╝█████╗  ██████╔╝██╔██╗ ██║█████╗     ██║   ██║ ╚███╔╝       ║
║      ██║       ╚██╔╝  ██╔══██╗██╔══╝  ██╔══██╗██║╚██╗██║██╔══╝     ██║   ██║ ██╔██╗       ║
║      ╚██████╗   ██║   ██████╔╝███████╗██║  ██║██║ ╚████║███████╗   ██║   ██║██╔╝ ██╗      ║
║       ╚═════╝   ╚═╝   ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚═╝╚═╝  ╚═╝      ║
║                                                                                           ║
║                         Control Theory × Agent-First                                      ║
║                         Let's roll, no sprints!                                           ║
╚═══════════════════════════════════════════════════════════════════════════════════════════╝
`;

// 帮助信息
const HELP = `
${LOGO}
Version: ${pkg.version}

Usage:
  cnx <command> [options]

Commands:
  init <name>          Initialize a new PDCA-ready project ($cnx-project-init)
  backlog <requirement>  Plan and create stories ($cnx-backlog)
  build <us-id>        Execute user story ($cnx-story-build)
  fix <fix-id>         Execute bug fix ($cnx-fix-build)
  roll <prompt>        Quick implementation ($cnx-roll-build)
  sentinel [mode]      Run patrol checks ($cnx-sentinel)
  debug <url>          Deep diagnostic ($cnx-bb-debug)
  skills               List all available skills
  
Options:
  -h, --help           Show help
  -v, --version        Show version
  --skill-path         Show skills installation path

Examples:
  cnx init my-app
  cnx backlog "用户登录功能"
  cnx build US-001
  cnx sentinel patrol --mode=normal
  cnx debug https://example.com

Documentation:
  https://github.com/seanyao/cybernetix#readme
`;

// 技能映射
const SKILLS = {
  'init': 'cnx-project-init',
  'backlog': 'cnx-backlog',
  'build': 'cnx-story-build',
  'fix': 'cnx-fix-build',
  'roll': 'cnx-roll-build',
  'sentinel': 'cnx-sentinel',
  'debug': 'cnx-bb-debug',
  'analyze': 'cnx-bb-analyzer',
};

function printSkills() {
  console.log(LOGO);
  console.log('Available Skills:\n');
  console.log('  PDCA Phase | Skill Name        | Description');
  console.log('  -----------|-------------------|----------------------------------------');
  console.log('  -          | cnx-project-init  | Initialize PDCA-ready project');
  console.log('  PLAN       | cnx-backlog       | Requirements planning & story splitting');
  console.log('  DO         | cnx-story-build   | Story development (TCR→CI/CD)');
  console.log('  DO         | cnx-fix-build     | Bug fix & hotfix');
  console.log('  DO         | cnx-roll-build    | Quick one-sentence implementation');
  console.log('  CHECK      | cnx-sentinel      | Scheduled patrol & regression tests');
  console.log('  CHECK      | cnx-bb-debug      | Deep diagnostic with Black Box');
  console.log('  CHECK      | cnx-bb-analyzer   | Analyze diagnostic reports');
  console.log('  Support    | cnx-qa-cover      | Testing standards reference');
  console.log('\nUsage: Invoke skills directly in your AI coding environment');
  console.log('       e.g., $cnx-backlog "your requirement"');
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '-h' || command === '--help') {
    console.log(HELP);
    process.exit(0);
  }

  if (command === '-v' || command === '--version') {
    console.log(pkg.version);
    process.exit(0);
  }

  if (command === '--skill-path') {
    const skillPath = join(__dirname, '..', 'skills');
    console.log(skillPath);
    process.exit(0);
  }

  if (command === 'skills') {
    printSkills();
    process.exit(0);
  }

  // 显示命令对应的 Skill
  const skillName = SKILLS[command];
  if (skillName) {
    const skillPath = join(__dirname, '..', 'skills', skillName, 'SKILL.md');
    if (existsSync(skillPath)) {
      console.log(`\n📖 Skill: ${skillName}`);
      console.log(`📂 Path: ${skillPath}`);
      console.log(`\n💡 In AI coding environment, invoke as: $${skillName}`);
      console.log('\n--- SKILL.md ---\n');
      const content = readFileSync(skillPath, 'utf8');
      // 显示前 100 行
      const lines = content.split('\n').slice(0, 100);
      console.log(lines.join('\n'));
      if (content.split('\n').length > 100) {
        console.log('\n... (truncated, see full file for more)');
      }
    } else {
      console.error(`❌ Skill not found: ${skillName}`);
      console.log(`Expected at: ${skillPath}`);
      process.exit(1);
    }
  } else {
    console.error(`❌ Unknown command: ${command}`);
    console.log('\nRun "cnx --help" for usage information.');
    process.exit(1);
  }
}

main();
