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
  await expect(page.locator('#tree a.file')).toHaveCount(9);

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

test('subfolders start collapsed and the opened file is revealed', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#tree details').first()).toBeVisible();
  expect(await page.locator('#tree details[open]').count()).toBe(0);
  await page.locator('#tree details > summary', { hasText: 'api' }).click();
  await page.locator('#tree a.file', { hasText: 'openapi.yaml' }).click();
  await expect(page.locator('#title')).toHaveText('api/openapi.yaml');
  // deep link: the folder opens by itself
  await page.goto('/?x=1#/api/openapi.yaml');
  await expect(page.locator('#tree details[open] a.file.active')).toBeVisible();
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

test('renders AsyncAPI (v3) with channels, operations and schemas', async ({ page }) => {
  await page.goto('/#/asyncapi.yaml');
  await expect(page.locator('.async h1')).toHaveText('Order Events');
  await expect(page.locator('.async-ch code', { hasText: 'orders/{region}/placed' })).toBeVisible();
  await expect(page.locator('.async-act', { hasText: 'SEND' })).toBeVisible();
  await expect(page.locator('.async-act', { hasText: 'RECEIVE' })).toBeVisible();
  // $ref'd message payload resolved down to nested fields
  await expect(page.locator('.async-schema td code', { hasText: 'quantity' }).first()).toBeVisible();
  await expect(page.locator('#pv-error')).toBeHidden();
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
  await page.goto('/');
  await page.locator('#new').click();
  await page.locator('#new-types button', { hasText: 'Markdown' }).click();
  await page.locator('#new-dir').fill('notes');
  await page.locator('#new-name').fill('e2e-created');
  await expect(page.locator('#new-path')).toHaveText('notes/e2e-created.md');
  await page.locator('#new-create').click();
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

test('opens the git changes dialog from the footer', async ({ page, request }) => {
  const g = await (await request.get('/api/git')).json();
  test.skip(!g.repo, 'git is not installed');
  await page.goto('/');
  const row = page.locator('#foot .git-row');
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('#git-dlg')).toBeVisible();
  await expect(page.locator('#git-commit')).toBeDisabled(); // no message yet
  await page.keyboard.press('Escape');
  await expect(page.locator('#git-dlg')).toBeHidden();
});

// Synthetic drag events: Playwright cannot drive native HTML5 drag and drop.
async function drop(page: Page, selector: string, setup: (dt: DataTransfer) => void) {
  const dt = await page.evaluateHandle((src) => {
    const d = new DataTransfer();
    new Function('dt', src)(d);
    return d;
  }, `(${setup.toString()})(dt)`);
  await page.dispatchEvent(selector, 'dragover', { dataTransfer: dt });
  await page.dispatchEvent(selector, 'drop', { dataTransfer: dt });
}

test('drag and drop moves a file into a folder and back to the root', async ({ page }) => {
  await page.goto('/');
  await drop(page, '#tree details[data-dir="api"] > summary', (dt) => dt.setData('application/x-specli-path', 'roles.csv'));
  await expect(page.locator('#tree a.file[data-path="api/roles.csv"]')).toHaveCount(1);
  await expect(page.locator('#tree a.file[data-path="roles.csv"]')).toHaveCount(0);
  await drop(page, '#tree', (dt) => dt.setData('application/x-specli-path', 'api/roles.csv'));
  await expect(page.locator('#tree a.file[data-path="roles.csv"]')).toHaveCount(1);
});

test('context menu duplicates, copies/pastes and deletes a file', async ({ page }) => {
  await page.goto('/');
  const file = (p: string) => page.locator(`#tree a.file[data-path="${p}"]`);
  await file('flow.mmd').click({ button: 'right' });
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(file('flow copy.mmd')).toHaveCount(1);
  await file('flow.mmd').click({ button: 'right' });
  await page.getByRole('button', { name: 'Copy' }).click();
  await page.locator('#tree details > summary', { hasText: 'api' }).click({ button: 'right' });
  await page.getByRole('button', { name: /^Paste/ }).click();
  await expect(file('api/flow.mmd')).toHaveCount(1);
  await file('flow copy.mmd').click({ button: 'right' });
  await page.getByRole('button', { name: /^Rename/ }).click();
  await page.locator('#file-name').fill('flow2.mmd');
  await page.locator('#file-ok').click();
  await expect(file('flow2.mmd')).toHaveCount(1);
  await expect(file('flow copy.mmd')).toHaveCount(0);
  for (const p of ['flow2.mmd', 'api/flow.mmd']) {
    await file(p).click({ button: 'right' });
    await page.getByRole('button', { name: /^Delete/ }).click();
    await expect(page.locator('#file-name')).toBeHidden();
    await page.locator('#file-ok').click();
    await expect(file(p)).toHaveCount(0);
  }
});

test('context menu on a folder creates a file or a folder', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tree details > summary', { hasText: 'api' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'New file…' }).click();
  await expect(page.locator('#new-dir')).toHaveValue('api');
  await page.locator('#new-dlg').getByRole('button', { name: 'Cancel' }).click();
  await page.dispatchEvent('#tree', 'contextmenu', { clientX: 100, clientY: 100 });
  await page.getByRole('button', { name: 'New folder…' }).click();
  await page.locator('#file-name').fill('notes');
  await page.locator('#file-ok').click();
  await expect(page.locator('#new-dir')).toHaveValue('notes');
  await page.locator('#new-dlg').getByRole('button', { name: 'Cancel' }).click();
});

test('shows spec status and lint issues, and filters by status', async ({ page }) => {
  const path = 'lintcheck.md';
  const content = '---\nstatus: draft\n---\n# Lint check\n\n## Empty\n\n## Next\nTODO fill in [x](nope.md)\n';
  await page.request.put('/api/file?path=' + path, { data: { content, baseMtime: '', eol: 'lf' } });
  await page.goto('/#/' + path);
  const link = page.locator(`#tree a.file[data-path="${path}"]`);
  await expect(link.locator('.status-draft')).toHaveText('draft');
  await expect(link.locator('.lint-n')).toHaveText('3');
  await expect(page.locator('#lint')).toHaveText('⚠ 3');
  await page.locator('#lint').click();
  await expect(page.locator('#lint-panel button')).toHaveCount(3);
  await page.locator('#filter').fill('status:draft');
  await expect(link).toHaveCount(1);
  await expect(page.locator('#tree a.file')).not.toHaveCount(9);
  await page.locator('#filter').fill('status:approved');
  await expect(link).toHaveCount(0);
  await expect(page.locator('.cm-lint-line')).toHaveCount(2);
  await page.request.post('/api/delete', { data: { path } });
});

test('the sidebar can be resized', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.locator('#sidebar');
  const before = (await sidebar.boundingBox())!.width;
  const box = (await page.locator('#resizer').boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 163, box.y + 100, { steps: 4 });
  await page.mouse.up();
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(before + 100);
  await page.reload();
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(before + 100);
  await page.locator('#resizer').dblclick();
  expect((await sidebar.boundingBox())!.width).toBeCloseTo(before, 0);
});

// Adds a file, so keep it last: other tests count the example files.
test('moving a file updates the links that point to it', async ({ page, request }) => {
  const put = (path: string, content: string) =>
    request.put('/api/file?path=' + path, { data: { content, baseMtime: '', eol: 'lf' } });
  await put('linksrc.md', '# Source\n\nSee [target](linktarget.md#a).\n');
  await put('linktarget.md', '# Target\n');
  await page.goto('/');
  await drop(page, '#tree details[data-dir="api"] > summary', (dt) => dt.setData('application/x-specli-path', 'linktarget.md'));
  await expect(page.locator('#banner')).toContainText('Updated the links in 1 file');
  expect((await (await request.get('/api/file?path=linksrc.md')).json()).content).toContain('(api/linktarget.md#a)');
  await request.post('/api/delete', { data: { path: 'linksrc.md' } });
  await request.post('/api/delete', { data: { path: 'api/linktarget.md' } });
});

test('dropping a file from the desktop adds it to the specs', async ({ page }) => {
  await page.goto('/');
  await drop(page, '#tree', (dt) => dt.items.add(new File(['# Dropped\n'], 'dropped.md', { type: 'text/markdown' })));
  await expect(page.locator('#tree a.file[data-path="dropped.md"]')).toHaveCount(1);
  await expect(page.locator('#title')).toHaveText('dropped.md');
});
