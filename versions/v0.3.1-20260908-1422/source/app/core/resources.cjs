'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  validateName, atomicJSON, readJSON, child, directory, noLinks, regularFile,
  copyTreeSafe, scrubCredentials, exclusive, within
} = require('./storage.cjs');

const KINDS = ['presets', 'characters', 'skills', 'workflows', 'tools'];
const MANIFEST = '.resource.json';
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const fail = (code, message) => Object.assign(new Error(message), { code });
const validResource = value => value?.format === 'createmore-resource' && value.version === 1 && typeof value.id === 'string' && typeof value.name === 'string' && KINDS.includes(value.kind) && Number.isInteger(value.revision) && value.revision > 0;

class ResourceStore {
  constructor({ appDir } = {}) {
    if (!appDir) throw fail('APP_DIR_REQUIRED', '必须提供软件安装目录。');
    this.root = path.join(path.resolve(appDir), 'resources');
  }

  async _root(kind, source = 'user', create = true) {
    if (!KINDS.includes(kind) || !['builtin', 'user'].includes(source)) throw fail('INVALID_RESOURCE_KIND', '资源类型或来源不正确。');
    return directory(child(this.root, kind + '/' + source), create);
  }

  async list(kind, { source, includeDisabled = true } = {}) {
    if (!KINDS.includes(kind)) throw fail('INVALID_RESOURCE_KIND', '资源类型不正确。');
    const records = [];
    for (const scope of source ? [source] : ['builtin', 'user']) {
      let root;
      try { root = await this._root(kind, scope, false); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const resourceDir = child(root, entry.name);
        try {
          const resource = (await readJSON(child(resourceDir, MANIFEST), validResource)).value;
          if (resource.kind !== kind) throw fail('INVALID_RESOURCE_KIND', '资源清单类型与目录不匹配。');
          if (includeDisabled || resource.enabled !== false) records.push({ ...resource, source: scope, resourceDir });
        } catch (err) { records.push({ name: entry.name, kind, source: scope, resourceDir, invalid: true, error: err.message }); }
      }
    }
    return records.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  async get(kind, resourceId, { source } = {}) {
    const matches = (await this.list(kind, { source })).filter(resource => !resource.invalid && resource.id === resourceId);
    if (matches.length !== 1) throw fail(matches.length ? 'AMBIGUOUS_RESOURCE' : 'RESOURCE_NOT_FOUND', matches.length ? '资源标识重复，请修复库。' : '资源不存在。');
    return matches[0];
  }

  async _nameAvailable(root, name, originalDir) {
    validateName(name);
    const conflict = (await fs.readdir(root)).find(entry => entry.toLowerCase() === name.toLowerCase() && (!originalDir || path.resolve(root, entry).toLowerCase() !== path.resolve(originalDir).toLowerCase()));
    if (conflict) throw fail('NAME_CONFLICT', '已有同名资源，不会覆盖；请使用其他名称。');
  }

  async save(kind, data, { source = 'user', files = [] } = {}) {
    validateName(data?.name);
    const root = await this._root(kind, source);
    return exclusive(root, async () => {
      let previous;
      if (data.id) { try { previous = await this.get(kind, data.id, { source }); } catch (err) { if (err.code !== 'RESOURCE_NOT_FOUND') throw err; } }
      if (previous?.reference && ('content' in data || files.length || (data.reference && data.reference.path !== previous.reference.path))) throw fail('REFERENCE_READ_ONLY', '引用 Skill 的原文件只读，请复制为个人 Skill 后再编辑。');
      await this._nameAvailable(root, data.name, previous?.resourceDir);
      if (kind === 'characters' && !data.cover && !previous?.cover) throw fail('CHARACTER_COVER_REQUIRED', '创建角色必须指定名称和封面。');
      if (kind !== 'skills' && data.reference) throw fail('INVALID_REFERENCE', '只有 Skill 支持引用本机原文件。');
      if (data.reference) {
        const reference = await regularFile(data.reference.path);
        if (path.basename(reference.absolute).toLowerCase() !== 'skill.md') throw fail('INVALID_SKILL_REFERENCE', '请引用 Skill 的 SKILL.md。');
      }
      const resourceId = previous?.id || data.id || crypto.randomUUID();
      validateName(resourceId);
      const stage = child(root, '.staging-' + crypto.randomUUID());
      await directory(stage, true);
      try {
        if (previous) await copyTreeSafe(previous.resourceDir, stage);
        const resource = { ...(previous || {}), ...clone(data), format: 'createmore-resource', version: 1, id: resourceId, kind, source, revision: (previous?.revision || 0) + 1, enabled: data.enabled ?? previous?.enabled ?? true, createdAt: previous?.createdAt || now(), updatedAt: now() };
        delete resource.resourceDir; delete resource.invalid; delete resource.error; delete resource.content;
        for (const file of files) {
          const original = await regularFile(file.sourcePath), destination = child(stage, file.relativePath);
          if (file.relativePath.split(/[\\/]/).some(part => part.startsWith('.'))) throw fail('INVALID_RESOURCE_FILE', '附属文件不能覆盖隐藏清单或配置。');
          await directory(path.dirname(destination), true); await noLinks(destination);
          await fs.copyFile(original.absolute, destination);
        }
        if (typeof data.content === 'string') {
          if (kind !== 'skills') throw fail('INVALID_CONTENT', '仅 Skill 使用 SKILL.md 文本。');
          const target = child(stage, 'SKILL.md'); await noLinks(target);
          await fs.writeFile(target, data.content, 'utf8');
        }
        if (resource.reference) resource.reference = { path: (await regularFile(resource.reference.path)).absolute, readonly: true };
        if (kind === 'skills' && !resource.reference) await regularFile(child(stage, 'SKILL.md'));
        if (resource.cover) {
          if (path.isAbsolute(resource.cover) || path.win32.isAbsolute(resource.cover)) {
            const cover = await regularFile(resource.cover);
            const name = 'cover' + path.extname(cover.absolute).toLowerCase();
            const target = child(stage, name); await noLinks(target); await fs.copyFile(cover.absolute, target);
            resource.cover = name;
          } else await regularFile(child(stage, resource.cover));
        }
        if (kind === 'workflows') {
          if (resource.gui === undefined || !resource.api || !resource.mapping) throw fail('WORKFLOW_CONFIGURATION_REQUIRED', '工作流必须同时包含普通工作流、执行数据和映射配置；API 格式的普通工作流可明确记为 null。');
          // A single manifest commits all three representations together.
        }
        await atomicJSON(child(stage, MANIFEST), resource, { backup: false });
        const destination = child(root, resource.name);
        let prior;
        if (previous) {
          prior = child(root, '.previous-' + resourceId + '-' + previous.revision + '-' + crypto.randomUUID().slice(0, 8));
          await fs.rename(previous.resourceDir, prior);
        }
        try { await fs.rename(stage, destination); }
        catch (err) { if (prior) await fs.rename(prior, previous.resourceDir); throw err; }
        return { ...resource, resourceDir: destination, previousDirectory: prior || null };
      } catch (err) { err.stagingDirectory = stage; throw err; }
    });
  }

  async setEnabled(kind, resourceId, enabled) {
    const resource = await this.get(kind, resourceId);
    return this.save(kind, { ...resource, enabled: Boolean(enabled) }, { source: resource.source });
  }

  async rename(kind, resourceId, name) {
    const resource = await this.get(kind, resourceId);
    return this.save(kind, { ...resource, name }, { source: resource.source });
  }

  async remove(kind, resourceId, { source } = {}) {
    const resource = await this.get(kind, resourceId, { source });
    const trash = await directory(child(this.root, '.trash'), true);
    const destination = child(trash, kind + '-' + resource.id + '-' + crypto.randomUUID().slice(0, 8));
    await noLinks(resource.resourceDir); await fs.rename(resource.resourceDir, destination);
    return { removed: true, id: resource.id, trashPath: destination, recoverable: true, referenceUntouched: Boolean(resource.reference) };
  }

  async referenceSkill(name, skillPath, metadata = {}) {
    return this.save('skills', { ...metadata, name, reference: { path: skillPath, readonly: true } });
  }

  async readSkill(resourceId, { allowDisabled = false } = {}) {
    const resource = await this.get('skills', resourceId);
    if (!allowDisabled && resource.enabled === false) throw fail('SKILL_DISABLED', '此 Skill 已禁用，不会加载到执行上下文。');
    const target = resource.reference?.path || child(resource.resourceDir, 'SKILL.md');
    const file = await regularFile(target);
    return { ...resource, content: await fs.readFile(file.absolute, 'utf8'), skillPath: file.absolute, baseDirectory: path.dirname(file.absolute), readonly: Boolean(resource.reference) };
  }

  async copySkill(resourceId, name) {
    const original = await this.readSkill(resourceId, { allowDisabled: true });
    // Copy all referenced attachments; this never writes back to the source Skill.
    const root = await this._root('skills', 'user');
    await this._nameAvailable(root, name);
    const stage = child(root, '.import-' + crypto.randomUUID());
    await copyTreeSafe(original.baseDirectory, stage);
    const metadata = { ...original, id: crypto.randomUUID(), name, reference: undefined, source: 'user', copiedFrom: { id: original.id, revision: original.revision }, revision: 1, createdAt: now(), updatedAt: now() };
    for (const key of ['content', 'skillPath', 'baseDirectory', 'readonly', 'resourceDir', 'previousDirectory']) delete metadata[key];
    await atomicJSON(child(stage, MANIFEST), metadata, { backup: false });
    await fs.rename(stage, child(root, name));
    return this.get('skills', metadata.id);
  }

  async export(kind, resourceId, destination) {
    const resource = await this.get(kind, resourceId);
    destination = await noLinks(destination);
    if (within(resource.resourceDir, destination) || within(destination, resource.resourceDir)) throw fail('UNSAFE_DESTINATION', '导出目标不能与原资源相互包含。');
    try { if ((await fs.readdir(destination)).length) throw fail('DESTINATION_NOT_EMPTY', '导出目录必须为空。'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const stage = destination + '.partial-' + crypto.randomUUID();
    await directory(stage, true);
    const source = resource.reference ? path.dirname((await regularFile(resource.reference.path)).absolute) : resource.resourceDir;
    await copyTreeSafe(source, stage, { sanitize: true });
    const metadata = scrubCredentials({ ...resource, reference: undefined, exportedAt: now() });
    delete metadata.resourceDir; delete metadata.previousDirectory;
    await atomicJSON(child(stage, MANIFEST), metadata, { backup: false });
    try { await fs.rmdir(destination); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    await fs.rename(stage, destination);
    return { path: destination, id: resourceId, kind, standalone: true };
  }

  async import(kind, sourceDirectory, { name } = {}) {
    sourceDirectory = await directory(sourceDirectory);
    const original = (await readJSON(child(sourceDirectory, MANIFEST), validResource)).value;
    if (original.kind !== kind) throw fail('INVALID_RESOURCE_KIND', '导入包与目标资源类型不匹配。');
    if (original.reference) throw fail('NON_PORTABLE_REFERENCE', '此资源仅引用原电脑路径，请先由原电脑导出完整资料。');
    const root = await this._root(kind, 'user');
    return exclusive(root, async () => {
      let nextName = name || original.name;
      validateName(nextName);
      const existing = new Set((await fs.readdir(root)).map(entry => entry.toLowerCase()));
      if (name && existing.has(name.toLowerCase())) throw fail('NAME_CONFLICT', '已有同名资源，请使用其他名称。');
      if (!name) {
        let number = 2;
        while (existing.has(nextName.toLowerCase())) nextName = original.name.slice(0, 85) + ' (' + number++ + ')';
      }
      const stage = child(root, '.import-' + crypto.randomUUID());
      await copyTreeSafe(sourceDirectory, stage, { sanitize: true });
      const resource = { ...scrubCredentials(original), id: crypto.randomUUID(), name: nextName, source: 'user', revision: 1, importedFrom: original.id, createdAt: now(), updatedAt: now() };
      if (resource.cover) await regularFile(child(stage, resource.cover));
      if (kind === 'characters' && !resource.cover) throw fail('CHARACTER_COVER_REQUIRED', '角色包缺少封面。');
      if (kind === 'skills') await regularFile(child(stage, 'SKILL.md'));
      await atomicJSON(child(stage, MANIFEST), resource, { backup: false });
      const destination = child(root, nextName); await fs.rename(stage, destination);
      return { ...resource, resourceDir: destination };
    });
  }
}

module.exports = { ResourceStore, KINDS };
