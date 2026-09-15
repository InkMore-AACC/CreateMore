'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ResourceStore } = require('../app/core/resources.cjs');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'createmore-resources-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('createmore-resources-')); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store: new ResourceStore({ appDir: path.join(root, 'app') }) };
}

test('resource namespaces separate builtins and user folders, same-name saves never overwrite', async t => {
  const { store } = await setup(t);
  assert.deepEqual(await store.list('presets'), []);
  const personal = await store.save('presets', { name: '山野预设', nodes: [{ type: 'custom.unknown', metadata: { preserve: true } }], edges: [] });
  const builtin = await store.save('presets', { name: '山野预设', nodes: [] }, { source: 'builtin' });
  assert.notEqual(personal.resourceDir, builtin.resourceDir); assert.equal((await store.list('presets')).length, 2);
  await assert.rejects(store.save('presets', { name: '山野预设', nodes: [] }), { code: 'NAME_CONFLICT' });
  assert.equal((await store.get('presets', personal.id)).nodes[0].metadata.preserve, true);
});

test('rename moves independent resource folder and retains previous recoverable revision', async t => {
  const { store } = await setup(t);
  const first = await store.save('tools', { name: 'Image Tool', enabled: true, sourceKind: 'local' });
  const renamed = await store.rename('tools', first.id, '工具 A');
  assert.equal(path.basename(renamed.resourceDir), '工具 A'); assert.equal(renamed.revision, 2);
  assert.equal(await fs.access(first.resourceDir).then(() => true, () => false), false);
  assert.ok((await fs.stat(renamed.previousDirectory)).isDirectory());
  await assert.rejects(store.rename('tools', first.id, 'CON'), { code: 'INVALID_NAME' });
});

test('character creation requires real cover and copies source without modifying it', async t => {
  const { root, store } = await setup(t);
  await assert.rejects(store.save('characters', { name: '旅人' }), { code: 'CHARACTER_COVER_REQUIRED' });
  const cover = path.join(root, 'cover.png'); await fs.writeFile(cover, 'original-cover');
  const voice = path.join(root, 'voice.wav'); await fs.writeFile(voice, 'original-audio');
  const character = await store.save('characters', { name: '旅人', cover, description: '', attachments: ['audio/sample.wav'] }, { files: [{ sourcePath: voice, relativePath: 'audio/sample.wav' }] });
  assert.equal(character.cover, 'cover.png');
  assert.equal(await fs.readFile(path.join(character.resourceDir, 'cover.png'), 'utf8'), 'original-cover');
  assert.equal(await fs.readFile(path.join(character.resourceDir, 'audio', 'sample.wav'), 'utf8'), 'original-audio');
  assert.equal(await fs.readFile(cover, 'utf8'), 'original-cover');
});

test('referenced Skill cannot be edited and disabling prevents actual loading', async t => {
  const { root, store } = await setup(t);
  const source = path.join(root, 'original-skill'); await fs.mkdir(source);
  const skillPath = path.join(source, 'SKILL.md'); await fs.writeFile(skillPath, '# Original\nRead-only text');
  const resource = await store.referenceSkill('引用技能', skillPath, { classification: 'style' });
  assert.equal((await store.readSkill(resource.id)).content, '# Original\nRead-only text');
  await assert.rejects(store.save('skills', { ...resource, content: 'replace original' }), { code: 'REFERENCE_READ_ONLY' });
  await store.setEnabled('skills', resource.id, false);
  await assert.rejects(store.readSkill(resource.id), { code: 'SKILL_DISABLED' });
  assert.equal((await store.list('skills', { includeDisabled: false })).length, 0);
  assert.equal((await store.readSkill(resource.id, { allowDisabled: true })).content, '# Original\nRead-only text');
  const removal = await store.remove('skills', resource.id);
  assert.equal(removal.referenceUntouched, true); assert.equal(removal.recoverable, true);
  assert.equal(await fs.readFile(skillPath, 'utf8'), '# Original\nRead-only text');
});

test('copying referenced Skill includes attachments and becomes independently editable', async t => {
  const { root, store } = await setup(t);
  const source = path.join(root, 'original-skill'); await fs.mkdir(source); await fs.mkdir(path.join(source, 'references'));
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Skill'); await fs.writeFile(path.join(source, 'references', 'guide.md'), 'source-attachment');
  const reference = await store.referenceSkill('引用', path.join(source, 'SKILL.md'));
  const copied = await store.copySkill(reference.id, '个人技能');
  assert.equal(copied.reference, undefined); assert.equal(await fs.readFile(path.join(copied.resourceDir, 'references', 'guide.md'), 'utf8'), 'source-attachment');
  await store.save('skills', { ...copied, content: '# Changed' });
  assert.equal((await store.readSkill(copied.id)).content, '# Changed');
  assert.equal(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), '# Skill');
});

test('workflow stores atomic triplet and failed update leaves existing version usable', async t => {
  const { store } = await setup(t);
  const config = { name: '本地工作流', gui: { nodes: [] }, api: { a: { class_type: 'Text' } }, mapping: { inputs: [] } };
  const workflow = await store.save('workflows', config);
  await assert.rejects(store.save('workflows', { id: workflow.id, name: workflow.name, mapping: null }), { code: 'WORKFLOW_CONFIGURATION_REQUIRED' });
  const retained = await store.get('workflows', workflow.id);
  assert.equal(retained.revision, 1); assert.deepEqual(retained.api, config.api);
});

test('directory export/import is self contained, same name imports create new independent entries', async t => {
  const { root, store } = await setup(t);
  const skill = await store.save('skills', { name: '风格', content: '# Style\nUseful instruction', classification: 'style', apiKey: 'must-not-export' });
  await store.save('skills', { ...skill, content: '# Style 2', password: 'must-not-export-either' });
  const destination = path.join(root, 'export'); await store.export('skills', skill.id, destination);
  const exported = JSON.parse(await fs.readFile(path.join(destination, '.resource.json'), 'utf8'));
  assert.equal(exported.apiKey, undefined); assert.equal(exported.password, undefined);
  assert.equal((await fs.readdir(destination)).some(name => name.includes('.previous')), false);
  const imported = await store.import('skills', destination);
  assert.equal(imported.name, '风格 (2)'); assert.notEqual(imported.id, skill.id);
  assert.equal((await store.readSkill(imported.id)).content, '# Style 2');
  const third = await store.import('skills', destination); assert.equal(third.name, '风格 (3)');
});

test('exporting a referenced Skill copies its real source and not the local path', async t => {
  const { root, store } = await setup(t);
  const source = path.join(root, 'original'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'SKILL.md'), '# Original');
  const resource = await store.referenceSkill('外部技能', path.join(source, 'SKILL.md'));
  const destination = path.join(root, 'export'); await store.export('skills', resource.id, destination);
  const exported = JSON.parse(await fs.readFile(path.join(destination, '.resource.json'), 'utf8'));
  assert.equal(exported.reference, undefined); assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# Original');
});

test('resource file traversal and symlink attachment export are rejected', async t => {
  const { root, store } = await setup(t);
  const file = path.join(root, 'source.txt'); await fs.writeFile(file, 'source');
  await assert.rejects(store.save('presets', { name: 'unsafe' }, { files: [{ sourcePath: file, relativePath: '../../escape' }] }), { code: 'UNSAFE_PATH' });
  await assert.rejects(store.save('tools', { id: '../escape', name: 'unsafe-id' }), { code: 'INVALID_NAME' });
  const resource = await store.save('presets', { name: 'test' });
  const other = path.join(root, 'external'); await fs.mkdir(other);
  try { await fs.symlink(other, path.join(resource.resourceDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (err) { if (err.code === 'EPERM') { t.skip('OS does not grant symlink creation'); return; } throw err; }
  await assert.rejects(store.export('presets', resource.id, path.join(root, 'package')), { code: 'SYMLINK_NOT_ALLOWED' });
});

test('resource deletion is recoverable and leaves applied canvas copies untouched', async t => {
  const { root, store } = await setup(t);
  const resource = await store.save('presets', { name: '独立预设', nodes: [{ id: 'original' }] });
  const independent = path.join(root, 'canvas-preset.json'); await fs.writeFile(independent, JSON.stringify(resource.nodes));
  const removed = await store.remove('presets', resource.id);
  assert.equal((await store.list('presets')).length, 0); assert.ok((await fs.stat(removed.trashPath)).isDirectory());
  assert.deepEqual(JSON.parse(await fs.readFile(independent, 'utf8')), [{ id: 'original' }]);
});
