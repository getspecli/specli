import { expect, test, type Page } from '@playwright/test';

// Any console error or warning (CSP violations, failed requests, exceptions)
// fails the test, so regressions in the security policy are caught here.
let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
});

test.afterEach(() => {
  expect(problems, 'browser console must stay clean').toEqual([]);
});

const previewText = (page: Page) => page.locator('#pv-body').evaluate((e) => (e.textContent ?? '').replace(/\s+/g, ' '));

test('lists files and renders Markdown with PlantUML and Mermaid', async ({ page }) => {
  await page.goto('/#/README.md');
  await expect(page.locator('.md h1')).toHaveText('Order Service – Design');
  await expect(page.locator('#tree a.file')).toHaveCount(8);

  // 3 PlantUML (2 embedded files + inline) and 4 Mermaid blocks
  const svgs = page.locator('.md .uml-page svg');
  await expect(svgs).toHaveCount(7);
  const all = (await svgs.evaluateAll((els) => els.map((e) => e.textContent ?? ''))).join(' ');
  expect(all).toContain('OrderService'); // ![](sequence.puml)
  expect(all).toContain('Order service'); // ![](archimate.puml) via !include <archimate/Archimate>
  expect(all).toContain('Alice'); // inline ```plantuml
  expect(all).toContain('Checkout'); // ```mermaid flowchart labels survive sanitizing

  await expect(page.locator('.md table tr')).toHaveCount(2);
  // links between spec files are rewritten to in-app navigation
  await expect(page.locator('.md a[href="#/api/openapi.yaml"]')).toHaveCount(1);
  await expect(page.locator('.md a.broken')).toHaveCount(0);
});

test('clicking a diagram opens a zoomable overlay', async ({ page }) => {
  await page.goto('/#/README.md');
  const svg = page.locator('.md .uml-page svg').first();
  await expect(svg).toBeVisible();
  await svg.click();
  const stage = page.locator('.zoom-stage');
  await expect(stage).toBeVisible();
  const before = (await stage.boundingBox())!.width;
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await stage.boundingBox())!.width).toBeGreaterThan(before);
  await page.keyboard.press('Escape');
  await expect(page.locator('.zoom-overlay')).toHaveCount(0);
});

test('renders a PlantUML class diagram (Graphviz layout)', async ({ page }) => {
  await page.goto('/#/classes.puml');
  await expect.poll(() => previewText(page)).toContain('OrderLine');
  await expect(page.locator('#pv-body .uml-err')).toHaveCount(0);
});

test('reports PlantUML errors with a line number and highlights the line', async ({ page }) => {
  await page.goto('/#/sequence.puml');
  await expect(page.locator('#pv-body svg')).toBeVisible();

  // a duplicated @startuml without @enduml (unsaved edit)
  await page.locator('#editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('@startuml\n');
  await expect(page.locator('#pv-body .uml-err')).toContainText('has no @end');
  await expect(page.locator('#pv-body .uml-err')).toContainText('Line 2');
  await expect(page.locator('#pv-body .uml-bad')).toHaveCount(1);

  // a syntax error reported by the engine itself
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('@startuml\nactor A\nfoo bar baz ->\n@enduml');
  await expect(page.locator('#pv-body .uml-err')).toContainText('Line 3: syntax error near "foo bar baz ->"');
  await expect(page.locator('#pv-body .uml-bad')).toContainText('foo bar baz');
});

test('renders a Mermaid file and reports syntax errors', async ({ page }) => {
  await page.goto('/#/flow.mmd');
  await expect.poll(() => previewText(page)).toContain('Payment ok?');

  await page.locator('#editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n  ???: %%% [');
  await expect(page.locator('#pv-body .uml-err')).toBeVisible();
  await expect(page.locator('#dirty')).toBeVisible();
});

test('renders OpenAPI with Swagger UI (view only) and reports YAML errors', async ({ page }) => {
  await page.goto('/#/api/openapi.yaml');
  await expect(page.locator('.swagger-ui .info .title')).toContainText('Order Service');
  await expect(page.locator('.swagger-ui .opblock')).toHaveCount(1);
  await expect(page.locator('.try-out__btn')).toHaveCount(0);

  await page.locator('#editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n  bad: x: y');
  await expect(page.locator('#pv-error')).toContainText('Parse error');
});

test('searches text and jumps to the matching line', async ({ page }) => {
  await page.goto('/#/sequence.puml');
  await expect.poll(() => previewText(page)).toContain('OrderService');

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#filter')).toBeFocused();
  await page.locator('#filter').fill('immutable');
  const hit = page.locator('#tree a.hit').first();
  await expect(hit).toContainText('Orders are immutable after payment');
  await expect(page.locator('#tree mark').first()).toHaveText('immutable');

  await hit.click();
  await expect(page.locator('#title')).toHaveText('README.md');
  await expect(page.locator('.cm-activeLine')).toContainText('Orders are immutable after payment');

  // results never show stale hits from an earlier query
  await page.locator('#filter').fill('flowchart');
  await expect(page.locator('#tree a.hit .tx').first()).toContainText('flowchart');
  await expect(page.locator('#tree a.hit .tx', { hasText: 'immutable' })).toHaveCount(0);
});

test('creates a file, saves it and survives a reload', async ({ page, request }) => {
  page.on('dialog', (d) => void d.accept('notes/e2e-created.md'));
  await page.goto('/');
  await page.locator('#new').click();
  await expect(page.locator('#title')).toHaveText('notes/e2e-created.md');

  await page.locator('#editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Saved by the e2e test');
  await expect(page.locator('#dirty')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('#dirty')).toBeHidden();

  const r = await request.get('/api/file?path=notes/e2e-created.md');
  expect((await r.json()).content).toContain('Saved by the e2e test');

  await page.reload();
  await expect(page.locator('.md')).toContainText('Saved by the e2e test');
});

test('opens files at the top and restores the position when returning', async ({ page }) => {
  await page.goto('/#/README.md');
  await expect(page.locator('.md .uml-page svg')).toHaveCount(7);
  const pv = page.locator('#preview');
  await pv.evaluate((e) => { e.scrollTop = 400; });
  await expect.poll(() => pv.evaluate((e) => e.scrollTop)).toBeGreaterThan(300);
  const left = await pv.evaluate((e) => e.scrollTop);

  await page.locator('#tree a.file', { hasText: 'roles.csv' }).click();
  await expect(page.locator('#title')).toHaveText('roles.csv');
  await expect.poll(() => pv.evaluate((e) => e.scrollTop)).toBe(0);

  await page.locator('#tree a.file', { hasText: 'README.md' }).click();
  await expect(page.locator('.md .uml-page svg')).toHaveCount(7);
  await expect.poll(() => pv.evaluate((e, l) => Math.abs(e.scrollTop - l), left)).toBeLessThan(5);
});

test('renders front matter and csv as tables', async ({ page }) => {
  await page.goto('/#/frontmatter.md');
  await expect(page.locator('.md h1')).toHaveText('Roles');
  await expect(page.locator('.md table.frontmatter tr')).toHaveCount(3);
  await expect(page.locator('.md table.frontmatter')).toContainText('auth, rbac');
  await page.goto('/#/roles.csv');
  await expect(page.locator('.md.csv tbody tr')).toHaveCount(2);
  await expect(page.locator('.md.csv')).toContainText('Read-only, no export');
});
