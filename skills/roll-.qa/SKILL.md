---
hidden: true
name: roll-.qa
license: MIT
description: QA coverage reference for build skills. Defines test pyramid (unit/E2E/visual/smoke), coverage requirements, and CI gates. Ensures quality assurance across all testing layers.
---

# QA Cover

This is a **reference skill** used by `roll-build` and `roll-fix` for quality assurance and test coverage.

## When to Apply

Any product with a user interface (Web, Desktop, Mobile) must follow these testing standards.

## When Not to Use

- Non-UI backends (APIs, CLI tools, data pipelines) — use project-specific test frameworks
- Spike code or throwaway prototypes that won't ship
- Per-commit self-review of diffs (use `$roll-.review`)

## Required Testing Levels

### 1. Unit Tests (Logic)
- **Tool**: Vitest / Jest
- **Coverage**: Business logic, utilities, hooks
- **Run**: `npm run test`

### 2. E2E Tests (User Flows)
- **Tool**: **Playwright** (default)
- **Coverage**: Critical user paths, interactions
- **Run**: `npm run test:e2e`

### 3. Visual Regression (UI Stability)
- **Tool**: Playwright screenshot testing
- **Coverage**: Key UI states
- **Run**: Part of E2E tests
- **Baseline**: Stored in `e2e/__snapshots__/`

### 4. Smoke Tests (Post-deploy)
- **Tool**: Playwright
- **Coverage**: Core functionality on production
- **Run**: `npm run test:e2e:smoke`

## Playwright Setup

### Installation
```bash
npm install -D @playwright/test
npx playwright install chromium
```

### Configuration (playwright.config.ts)
```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
```

### Required Test Files

**e2e/smoke.spec.ts** (Deployment verification)
```typescript
import { test, expect } from '@playwright/test';

test('app loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
});
```

**e2e/interaction.spec.ts** (User flows)
```typescript
test('user can complete core flow', async ({ page }) => {
  await page.goto('/');
  // Test critical user journey
});
```

**e2e/visual.spec.ts** (Visual regression)
```typescript
test('homepage visual', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveScreenshot('homepage.png');
});
```

### Package.json Scripts
```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:smoke": "playwright test smoke.spec.ts",
    "test:all": "npm run test && npm run test:e2e"
  }
}
```

## Visual Regression Workflow

### 1. Create Baseline (First Time)
```bash
npx playwright test --update-snapshots
```

### 2. Commit Baseline
```bash
git add e2e/__snapshots__/
git commit -m "chore: add visual regression baselines"
```

### 3. Subsequent Runs (Compare)
```bash
npm run test:e2e
# Fails if screenshots differ beyond threshold
```

### 4. Update Baseline (Intentional UI Change)
```bash
npx playwright test --update-snapshots
git add e2e/__snapshots__/
git commit -m "chore: update visual baseline for new design"
```

## CI/CD Integration

### Local Pre-push Checklist
- [ ] `npm run test` passes
- [ ] `npm run test:e2e` passes
- [ ] No unexpected visual regressions

### Post-deploy Smoke Test
```bash
# Against production URL
PLAYWRIGHT_BASE_URL=https://your-app.com npm run test:e2e:smoke
```

## Common Patterns

### Testing Canvas/Game Rendering
```typescript
test('game renders', async ({ page }) => {
  await page.goto('/');
  const canvas = page.locator('#gameCanvas');
  await expect(canvas).toBeVisible();
  
  // Visual regression for canvas
  await expect(page).toHaveScreenshot('game-initial.png', {
    maxDiffPixels: 100,
  });
});
```

### Testing Responsive Layouts
```typescript
test('responsive design', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');
  await expect(page.locator('.mobile-menu')).toBeVisible();
});
```

### Testing Voice/Audio Features
```typescript
test('voice button toggles', async ({ page }) => {
  await page.goto('/');
  const btn = page.locator('#voiceBtn');
  await btn.click();
  await expect(btn).toHaveClass(/active/);
});
```

## Failure Handling

### Flaky Tests
- Add `test.fixme()` to skip temporarily
- Increase `timeout` for slow operations
- Use `retries` in config for network-dependent tests

### Visual Regression Failures
1. Check if change is intentional
2. If yes: `npx playwright test --update-snapshots`
3. If no: fix the code

### Missing Test Infrastructure
If project lacks Playwright setup:
1. Install dependencies
2. Create config
3. Add basic smoke test
4. Run to create baseline
5. Commit as separate "test infrastructure" change

## References

- [Playwright Docs](https://playwright.dev/)
- [Visual Regression Guide](https://playwright.dev/docs/test-snapshots)
- Example implementation: `<owner>/<repo>/e2e/`
