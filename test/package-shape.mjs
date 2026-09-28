/**
 * Bundle-shape self-check for dsh-wait-guard.
 *
 * Verifies the contract an installer reads before anything runs: the manifest
 * fields, `dsh.bundle.patch`, the exports map, the published file set, the
 * display metadata, the icon rules, and that the patch row actually names this
 * package. Runs on plain Node with no dependencies: `node test/package-shape.mjs`.
 *
 * The YAML patch is parsed with `js-yaml` when the environment provides it, and
 * otherwise checked structurally, so the test never needs a network install.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

async function check(title, fn) {
    try {
        const detail = await fn();
        results.push([title, 'PASS', detail ?? '']);
    } catch (error) {
        results.push([title, 'FAIL', error?.message ?? String(error)]);
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const manifest = readJson('package.json');
const MAX_ICON_BYTES = 256 * 1024;

await check('manifest carries the bundle contract', () => {
    assert(typeof manifest.name === 'string' && manifest.name.length > 0, 'name is required');
    assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version ?? ''), `version must be semver, got ${manifest.version}`);
    assert(manifest.private !== true, 'a publishable bundle must not set private:true');
    assert(manifest.type === 'module', 'type must be module');
    assert(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must point at the patch');
    assert(manifest.publishConfig?.access === 'public', 'publishConfig.access must be public for an unscoped publish');
    assert(
        /^git\+https:\/\/github\.com\/[\w.-]+\/dsh-wait-guard\.git$/.test(manifest.repository?.url ?? ''),
        `repository must name a real repo, got ${JSON.stringify(manifest.repository?.url)}`,
    );
    assert(!JSON.stringify(manifest).includes('<owner>'), 'no placeholder may survive into a release');
    return `${manifest.name}@${manifest.version}`;
});

await check('a Host-only bundle declares no runtime dependencies', () => {
    const deps = Object.keys(manifest.dependencies ?? {});
    assert(deps.length === 0, `unexpected dependencies: ${deps.join(', ')}`);
    // A peer named @deepseek-ai/dsh* is compared against the *runtime* version by
    // the loader and can deny the row outright, so this bundle ships without one.
    const checked = Object.keys(manifest.peerDependencies ?? {})
        .filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'));
    assert(checked.length === 0, `checked peers would gate installation: ${checked.join(', ')}`);
});

await check('every exported, published and required path exists', () => {
    const exported = [manifest.main, ...Object.values(manifest.exports ?? {}).filter((value) => typeof value === 'string')];
    for (const path of exported) {
        if (path.includes('*')) continue;
        assert(existsSync(join(root, path)), `exports target missing: ${path}`);
    }
    for (const path of manifest.files ?? []) {
        if (path.includes('*')) continue;
        assert(existsSync(join(root, path)), `files entry missing: ${path}`);
    }
    const published = manifest.files ?? [];
    for (const path of ['lib/index.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.en.md', 'LICENSE']) {
        assert(published.includes(path), `${path} is not published`);
    }
    assert(published.includes('locale/*.json'), 'locale files are not published');
    assert(Object.hasOwn(manifest.exports, './package.json'), 'the manifest must be exported for display metadata');
    return `${exported.length} exported paths, ${published.length} published entries`;
});

await check('locale metadata is complete for display', () => {
    const locales = ['locale/en.json', 'locale/zh.json'];
    for (const path of locales) {
        const document = readJson(path);
        assert(typeof document.meta?.title === 'string' && document.meta.title.length > 0, `${path}: meta.title is required`);
        assert(typeof document.meta?.description === 'string' && document.meta.description.length > 0, `${path}: meta.description is required`);
    }
    return locales.join(', ');
});

await check('icon is a relative, in-package, size-legal image', () => {
    const icon = manifest.icon;
    assert(typeof icon === 'string' && icon.length > 0, 'icon is required for the Plugins card');
    assert(!icon.startsWith('/') && !/^[a-z]+:/i.test(icon), 'icon must be a relative path');
    assert(!icon.split('/').includes('..'), 'icon must not leave the package directory');
    assert(/\.(svg|png|jpe?g|webp)$/i.test(icon), `icon type not accepted: ${icon}`);
    const path = join(root, icon);
    assert(existsSync(path), `icon missing: ${icon}`);
    const size = statSync(path).size;
    assert(size <= MAX_ICON_BYTES, `icon is ${size}B, over the ${MAX_ICON_BYTES}B limit`);
    return `${icon} (${size}B)`;
});

await check('the patch inserts exactly one row naming this package', async () => {
    const text = readFileSync(join(root, manifest.dsh.bundle.patch), 'utf8');
    let document;
    try {
        const yaml = await import('js-yaml');
        document = yaml.load(text);
    } catch {
        // No YAML parser available: fall back to a structural check of this fixed shape.
        assert(/^- insert:\s*$/m.test(text), 'patch must start with `- insert:`');
        assert(text.includes(`name: '${manifest.name}'`), 'row must name this package');
        assert(/^\s+- id: wait-guard$/m.test(text), 'row must declare its id');
        assert(/firstWaitMs: \d+/.test(text), 'row must carry a config');
        return 'structural check (js-yaml unavailable)';
    }
    assert(Array.isArray(document) && document.length === 1, 'patch must be a one-element list');
    const rows = document[0]?.insert;
    assert(Array.isArray(rows) && rows.length === 1, 'patch must insert exactly one row');
    const [row] = rows;
    assert(row.id === 'wait-guard', `unexpected row id ${row.id}`);
    assert(row.name === manifest.name, `row must name the package: ${row.name} != ${manifest.name}`);
    assert(Number.isSafeInteger(row.config?.firstWaitMs), 'row config must carry firstWaitMs');
    return `id=${row.id} name=${row.name}`;
});

await check('the mounted module stays import-free and write-free', () => {
    const source = readFileSync(join(root, manifest.main), 'utf8');
    assert(!/^\s*import\s/m.test(source), 'the entry must not import anything at load time');
    assert(!/\brequire\s*\(/.test(source), 'the entry must not require anything');
    assert(!/node:fs|ctx\.settings|session\.append|tools\.register/.test(source), 'the entry must not write or register');
    return `${manifest.main} is import-free`;
});

let failed = 0;
for (const [title, status, detail] of results) {
    if (status === 'FAIL') failed += 1;
    console.log(`${status.padEnd(4)}  ${title}${detail ? `  —  ${detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
