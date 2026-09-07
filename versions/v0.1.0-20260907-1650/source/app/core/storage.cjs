'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');

const PROJECT_FILE = '.createmore.json';
const ASSET_DIRS = ['image', 'video', 'audio', 'text', 'other'];
const locks = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const error = (code, message) => Object.assign(new Error(message), { code });

function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 100 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^\.{1,2}$/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) {
    throw error('INVALID_NAME', '名称不符合 Windows 文件夹规则，请勿使用保留名称、路径字符或末尾空格。');
  }
  return name;
}

function within(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

function child(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) throw error('UNSAFE_PATH', '路径必须位于资源目录内。');
  if (relative.split(/[\\/]/).some(part => part.length > 255 || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw error('UNSAFE_PATH', '资源路径包含非法 Windows 文件名或备用数据流。');
  const target = path.resolve(root, ...relative.split(/[\\/]/));
  if (!within(root, target)) throw error('UNSAFE_PATH', '路径越过了项目范围。');
  return target;
}

async function noLinks(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw error('SYMLINK_NOT_ALLOWED', '为保护项目，不能读写符号链接或目录联接：' + current); }
    catch (err) { if (err.code === 'ENOENT') break; throw err; }
  }
  return absolute;
}

async function directory(target, create = false) {
  const absolute = await noLinks(target);
  if (create) await fs.mkdir(absolute, { recursive: true });
  if (!(await fs.stat(absolute)).isDirectory()) throw error('NOT_DIRECTORY', '请选择文件夹。');
  return absolute;
}

async function exclusive(key, operation) {
  const previous = locks.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  locks.set(key, pending);
  try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
}

async function atomicJSON(target, value, { backup = true } = {}) {
  await noLinks(target);
  await directory(path.dirname(target), true);
  const temporary = target + '.tmp-' + id();
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    if (backup) {
      await noLinks(target + '.previous');
      try {
        // Never replace the usable recovery file with a corrupt interrupted main file.
        JSON.parse(await fs.readFile(target, 'utf8'));
        const previousTemp = target + '.previous.tmp-' + id();
        await fs.copyFile(target, previousTemp);
        await fs.rename(previousTemp, target + '.previous');
      } catch (err) { if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err; }
    }
    await fs.rename(temporary, target);
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temporary).catch(err => { if (err.code !== 'ENOENT') throw err; });
  }
}

async function readJSON(target, validate = () => true) {
  await noLinks(target);
  const parse = async file => { await noLinks(file); const value = JSON.parse(await fs.readFile(file, 'utf8')); if (!validate(value)) throw error('INVALID_DOCUMENT', '文件结构不正确：' + file); return value; };
  try { return { value: await parse(target), recovered: false }; }
  catch (primaryError) {
    try { return { value: await parse(target + '.previous'), recovered: true, recoveryReason: primaryError.message }; }
    catch { throw primaryError; }
  }
}

function validState(state) {
  if (!state || state.version !== 5 || !Array.isArray(state.nodes) || !Array.isArray(state.edges) || !Array.isArray(state.groups) || !Array.isArray(state.assets)) return false;
  const ids = new Set();
  for (const node of state.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) || typeof node.type !== 'string' || typeof node.title !== 'string' || ![node.x, node.y, node.w, node.h].every(Number.isFinite) || node.w <= 0 || node.h <= 0) return false;
    ids.add(node.id);
  }
  return state.edges.every(edge => edge && typeof edge.id === 'string' && ids.has(edge.from) && ids.has(edge.to)) && state.groups.every(group => group && typeof group.id === 'string' && Array.isArray(group.members) && group.members.every(member => ids.has(member))) && state.view && [state.view.x, state.view.y, state.view.k].every(Number.isFinite) && state.view.k > 0 && Number.isFinite(state.seq);
}

function validProject(value) {
  return value?.format === 'createmore-project' && value.version === 1 && typeof value.id === 'string' && typeof value.name === 'string' && Array.isArray(value.canvases) && value.canvases.every(canvas => canvas && typeof canvas.id === 'string' && typeof canvas.name === 'string' && typeof canvas.directory === 'string') && new Set(value.canvases.map(canvas => canvas.id)).size === value.canvases.length && new Set(value.canvases.map(canvas => canvas.directory.toLowerCase())).size === value.canvases.length;
}
function validCanvas(value) { return value?.format === 'createmore-canvas' && value.version === 1 && typeof value.id === 'string' && validState(value.state); }

function mediaType(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.tif', '.tiff', '.avif'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.opus'].includes(ext)) return 'audio';
  if (['.txt', '.md', '.csv', '.srt', '.vtt', '.json'].includes(ext)) return 'text';
  return 'other';
}

async function fileHash(file) {
  const digest = crypto.createHash('sha256');
  const stream = require('node:fs').createReadStream(file);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest('hex');
}

async function regularFile(file) {
  const absolute = await noLinks(file);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw error('NOT_FILE', '素材必须是普通文件。');
  return { absolute, stat };
}

function scrubCredentials(value) {
  if (Array.isArray(value)) return value.map(scrubCredentials);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|password|passwd|secret|client[-_]?secret|authorization|cookie|credentials|login|session[-_]?token)$/i.test(key)).map(([key, item]) => [key, scrubCredentials(item)]));
  if (typeof value === 'string') return value.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[removed]').replace(/([?&](?:api_key|apiKey|token|access_token|password)=)[^&#\s]+/gi, '$1[removed]').replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1');
  return value;
}

async function copyTreeSafe(source, destination, { sanitize = false } = {}) {
  await directory(source);
  await directory(destination, true);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw error('SYMLINK_NOT_ALLOWED', '导出目录包含符号链接：' + entry.name);
    if (sanitize && (entry.name.startsWith('.') || /(?:\.previous|\.tmp-[\w-]+)$/.test(entry.name) || /^(auth\.json|credentials(?:\.json)?|connections\.json|secrets(?:\.json)?)$/i.test(entry.name))) continue;
    const from = child(source, entry.name), to = child(destination, entry.name);
    if (entry.isDirectory()) await copyTreeSafe(from, to, { sanitize });
    else if (entry.isFile()) {
      if (sanitize && path.extname(entry.name).toLowerCase() === '.json') await atomicJSON(to, scrubCredentials(JSON.parse(await fs.readFile(from, 'utf8'))), { backup: false });
      else { await noLinks(to); await fs.copyFile(from, to, require('node:fs').constants.COPYFILE_EXCL); }
    }
  }
}

function rewriteStrings(value, replacements) {
  if (typeof value === 'string') return replacements.has(value) ? replacements.get(value) : value;
  if (Array.isArray(value)) return value.map(item => rewriteStrings(item, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteStrings(item, replacements)]));
  return value;
}

class ProjectStore {
  constructor({ dataDir, appDir } = {}) {
    if (!dataDir) throw error('DATA_DIR_REQUIRED', '必须提供本机数据目录。');
    this.dataDir = path.resolve(dataDir);
    this.appDir = appDir ? path.resolve(appDir) : null;
  }

  async _project(projectDir) {
    projectDir = await directory(projectDir);
    const result = await readJSON(path.join(projectDir, PROJECT_FILE), validProject);
    for (const canvas of result.value.canvases) { validateName(canvas.directory); await noLinks(child(projectDir, canvas.directory)); }
    return { projectDir, ...result };
  }

  async _canvas(projectDir, canvasId) {
    const project = await this._project(projectDir);
    const entry = project.value.canvases.find(canvas => canvas.id === canvasId);
    if (!entry) throw error('CANVAS_NOT_FOUND', '画布不属于此项目。');
    const canvasDir = child(project.projectDir, entry.directory);
    const result = await readJSON(child(canvasDir, 'canvas.json'), value => validCanvas(value) && value.id === canvasId);
    return { project, entry, canvasDir, ...result };
  }

  async _remember(projectDir, manifest) {
    await directory(this.dataDir, true);
    const target = path.join(this.dataDir, 'recent-projects.json');
    await exclusive(target, async () => {
      let recent = [];
      try { recent = (await readJSON(target, Array.isArray)).value; } catch (err) { if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err; }
      recent = recent.filter(item => path.resolve(item.projectDir).toLowerCase() !== projectDir.toLowerCase());
      recent.unshift({ id: manifest.id, name: manifest.name, projectDir, openedAt: now() });
      await atomicJSON(target, recent.slice(0, 30));
    });
  }

  async createProject(projectDir, name) {
    validateName(name);
    projectDir = await directory(projectDir, true);
    return exclusive(path.join(projectDir, PROJECT_FILE), async () => {
      if ((await fs.readdir(projectDir)).some(entry => [PROJECT_FILE.toLowerCase(), PROJECT_FILE.toLowerCase() + '.previous'].includes(entry.toLowerCase()))) throw error('PROJECT_EXISTS', '此目录已有 CreateMore 项目或恢复文件，不会覆盖。');
      const manifest = { format: 'createmore-project', version: 1, id: id(), name, createdAt: now(), updatedAt: now(), canvases: [] };
      await atomicJSON(path.join(projectDir, PROJECT_FILE), manifest, { backup: false });
      await this._remember(projectDir, manifest);
      return { projectDir, ...manifest };
    });
  }

  async openProject(projectDir) {
    const project = await this._project(projectDir);
    await this._remember(project.projectDir, project.value);
    return { projectDir: project.projectDir, ...project.value, recovered: project.recovered, recoveryReason: project.recoveryReason };
  }

  async listRecent() {
    let records;
    try { records = (await readJSON(path.join(this.dataDir, 'recent-projects.json'), Array.isArray)).value; }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    return Promise.all(records.map(async record => ({ ...record, exists: await fs.access(path.join(record.projectDir, PROJECT_FILE)).then(() => true, () => false) })));
  }

  async listCanvases(projectDir) { return clone((await this._project(projectDir)).value.canvases); }

  async createCanvas(projectDir, name, state) {
    validateName(name);
    if (!validState(state)) throw error('INVALID_CANVAS', '画布数据不完整，未创建文件。');
    projectDir = path.resolve(projectDir);
    return exclusive(path.join(projectDir, PROJECT_FILE), async () => {
      const project = await this._project(projectDir);
      if ((await fs.readdir(projectDir)).some(entry => entry.toLowerCase() === name.toLowerCase())) throw error('NAME_CONFLICT', '已有同名文件或画布，请使用其他名称。');
      const canvasDir = child(projectDir, name);
      await fs.mkdir(canvasDir);
      for (const type of [...ASSET_DIRS, 'workflows', 'autosaves']) await fs.mkdir(child(canvasDir, type));
      const document = { format: 'createmore-canvas', version: 1, id: id(), name, createdAt: now(), updatedAt: now(), autosaveHash: hash(state), state: clone(state) };
      await atomicJSON(child(canvasDir, 'canvas.json'), document, { backup: false });
      await atomicJSON(child(canvasDir, 'asset-index.json'), state.assets, { backup: false });
      const entry = { id: document.id, name, directory: name, createdAt: document.createdAt, updatedAt: document.updatedAt };
      project.value.canvases.push(entry); project.value.updatedAt = now();
      await atomicJSON(path.join(projectDir, PROJECT_FILE), project.value);
      return { projectDir, canvasDir, ...document };
    });
  }

  async _assetIndex(canvasDir) {
    try { return (await readJSON(child(canvasDir, 'asset-index.json'), value => Array.isArray(value) && value.every(item => item && typeof item.id === 'string'))).value; }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  }

  async loadCanvas(projectDir, canvasId) {
    const canvas = await this._canvas(projectDir, canvasId);
    const state = clone(canvas.value.state);
    const assets = await this._assetIndex(canvas.canvasDir);
    const combined = new Map(state.assets.map(asset => [asset.id, asset]));
    for (const asset of assets) combined.set(asset.id, asset);
    state.assets = [...combined.values()];
    return { projectDir: canvas.project.projectDir, canvasDir: canvas.canvasDir, ...canvas.value, state, recovered: canvas.recovered, recoveryReason: canvas.recoveryReason };
  }

  async saveCanvas(projectDir, canvasId, state, { autosave = false, maxSnapshots } = {}) {
    if (!validState(state)) throw error('INVALID_CANVAS', '画布数据不完整，上一版文件保持不变。');
    const frozen = clone(state);
    const retention = maxSnapshots ?? frozen.settings?.maxSnapshots ?? 100;
    if (autosave && (!Number.isInteger(retention) || retention < 1 || retention > 10000)) throw error('INVALID_RETENTION', '自动保存保留份数必须为 1 到 10000。');
    return exclusive(path.resolve(projectDir) + ':' + canvasId, async () => {
      const canvas = await this._canvas(projectDir, canvasId);
      const assets = await this._assetIndex(canvas.canvasDir);
      const combined = new Map(assets.map(asset => [asset.id, asset]));
      for (const asset of frozen.assets) combined.set(asset.id, asset);
      frozen.assets = [...combined.values()];
      const digest = hash(frozen);
      const unchanged = digest === hash(canvas.value.state);
      let autosavePath = null;
      if (autosave && digest !== canvas.value.autosaveHash) {
        const filename = now().replace(/[:.]/g, '-') + '-' + id().slice(0, 8) + '.json';
        autosavePath = child(canvas.canvasDir, 'autosaves/' + filename);
        await atomicJSON(autosavePath, { ...canvas.value, state: frozen, updatedAt: now(), snapshotKind: 'autosave' }, { backup: false });
      }
      const document = { ...canvas.value, state: frozen, updatedAt: now(), autosaveHash: autosave ? digest : canvas.value.autosaveHash };
      await atomicJSON(child(canvas.canvasDir, 'asset-index.json'), frozen.assets);
      await atomicJSON(child(canvas.canvasDir, 'canvas.json'), document);
      await exclusive(path.join(canvas.project.projectDir, PROJECT_FILE), async () => {
        const current = await this._project(canvas.project.projectDir);
        const entry = current.value.canvases.find(item => item.id === canvasId);
        entry.updatedAt = document.updatedAt; current.value.updatedAt = document.updatedAt;
        await atomicJSON(path.join(current.projectDir, PROJECT_FILE), current.value);
      });
      if (autosavePath) await this._rotateAutosaves(canvas.canvasDir, retention);
      return { saved: true, canvasId, path: child(canvas.canvasDir, 'canvas.json'), autosavePath, unchanged };
    });
  }

  async _rotateAutosaves(canvasDir, maximum) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10000) throw error('INVALID_RETENTION', '自动保存保留份数必须为 1 到 10000。');
    const dir = await directory(child(canvasDir, 'autosaves'));
    const files = (await fs.readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile() && /^\d{4}-.*-[a-f0-9]{8}\.json$/.test(entry.name)).map(entry => entry.name).sort();
    for (const name of files.slice(0, Math.max(0, files.length - maximum))) { const target = child(dir, name); await noLinks(target); await fs.unlink(target); }
  }

  async importAsset(projectDir, canvasId, filePath, { copy = true, title, generated = false, assetId, owner } = {}) {
    if (assetId !== undefined && (typeof assetId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(assetId))) throw error('INVALID_ASSET_ID', '素材身份格式不正确。');
    const source = await regularFile(filePath);
    const digest = await fileHash(source.absolute);
    return exclusive(path.resolve(projectDir) + ':' + canvasId, async () => {
      const canvas = await this._canvas(projectDir, canvasId);
      const assets = await this._assetIndex(canvas.canvasDir);
      const existing = assetId ? assets.find(asset => asset.id === assetId) : null;
      if (existing?.sha256 && existing.sha256 !== digest) throw error('ASSET_ID_CONFLICT', '同一素材身份不能替换成不同文件内容，请创建新素材。');
      const type = mediaType(source.absolute);
      let assetPath = source.absolute;
      if (copy) {
        const ext = path.extname(source.absolute).slice(0, 16).toLowerCase();
        const safeBase = path.basename(source.absolute, path.extname(source.absolute)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 60) || 'asset';
        const filename = digest.slice(0, 16) + '-' + safeBase + ext;
        assetPath = type + '/' + filename;
        const destination = child(canvas.canvasDir, assetPath);
        await directory(path.dirname(destination), true); await noLinks(destination);
        try { await fs.copyFile(source.absolute, destination, require('node:fs').constants.COPYFILE_EXCL); }
        catch (err) { if (err.code !== 'EEXIST' || await fileHash(destination) !== digest) throw err; }
        if (await fileHash(destination) !== digest) throw error('COPY_VERIFY_FAILED', '素材复制后校验不一致。');
      }
      const internal = within(canvas.canvasDir, source.absolute);
      if (!copy && internal) assetPath = path.relative(canvas.canvasDir, source.absolute).split(path.sep).join('/');
      const asset = { ...existing, id: assetId || id(), title: title || existing?.title || path.basename(source.absolute), type, asset: assetPath, path: assetPath, external: !copy && !internal, generated: Boolean(generated || existing?.generated), size: source.stat.size, sha256: digest, createdAt: existing?.createdAt || now() };
      if (owner) asset.owner = owner;
      await atomicJSON(child(canvas.canvasDir, 'asset-index.json'), [...assets.filter(item => item.id !== asset.id), asset]);
      return asset;
    });
  }

  async resolveAssetPath(projectDir, canvasId, assetOrId) {
    const canvas = await this._canvas(projectDir, canvasId);
    let reference = assetOrId;
    if (typeof reference === 'string') {
      const record = (await this._assetIndex(canvas.canvasDir)).find(asset => asset.id === reference);
      if (record) reference = record;
    }
    const raw = typeof reference === 'string' ? reference : reference?.path || reference?.asset;
    if (typeof raw !== 'string' || !raw) throw error('ASSET_NOT_FOUND', '素材没有可读取的文件路径。');
    if (/^file:/i.test(raw)) return (await regularFile(fileURLToPath(raw))).absolute;
    if (/^[a-z]+:/i.test(raw) && !path.win32.isAbsolute(raw)) throw error('REMOTE_ASSET', '远程或内嵌素材需先保存为本地文件。');
    if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) return (await regularFile(raw)).absolute;
    return (await regularFile(child(canvas.canvasDir, raw))).absolute;
  }

  async relinkAsset(projectDir, canvasId, assetId, newFilePath, { batch = false } = {}) {
    const source = await regularFile(newFilePath);
    return exclusive(path.resolve(projectDir) + ':' + canvasId, async () => {
      const canvas = await this.loadCanvas(projectDir, canvasId);
      const selected = canvas.state.assets.find(asset => asset.id === assetId);
      if (!selected) throw error('ASSET_NOT_FOUND', '素材记录不存在。');
      if (selected.sha256 && await fileHash(source.absolute) !== selected.sha256) throw error('ASSET_CONTENT_MISMATCH', '所选文件内容与原素材不一致；未替换，请将不同内容作为新素材导入。');
      const replacements = new Map(), updated = [], ambiguous = [], missing = [];
      const entries = batch ? await fs.readdir(path.dirname(source.absolute), { withFileTypes: true }) : [];
      for (const asset of canvas.state.assets) {
        const original = asset.path || asset.asset;
        let replacement = asset.id === assetId ? source.absolute : null;
        if (!replacement && batch && typeof original === 'string') {
          const previous = path.isAbsolute(original) ? original : child(canvas.canvasDir, original);
          if (await fs.access(previous).then(() => true, () => false)) continue;
          const basename = path.win32.basename(original).toLowerCase();
          const matches = entries.filter(entry => entry.isFile() && entry.name.toLowerCase() === basename);
          if (matches.length > 1) { ambiguous.push({ id: asset.id, candidates: matches.map(entry => entry.name) }); continue; }
          if (matches.length === 0) { missing.push(asset.id); continue; }
          const candidate = path.join(path.dirname(source.absolute), matches[0].name);
          if (asset.sha256 && await fileHash(candidate) !== asset.sha256) { ambiguous.push({ id: asset.id, candidates: [candidate], reason: '文件内容与原素材不一致' }); continue; }
          replacement = candidate;
        }
        if (!replacement) continue;
        const details = await regularFile(replacement);
        if (typeof asset.asset === 'string') replacements.set(asset.asset, replacement);
        if (typeof asset.path === 'string') replacements.set(asset.path, replacement);
        Object.assign(asset, { asset: replacement, path: replacement, external: true, size: details.stat.size, sha256: await fileHash(replacement), relinkedAt: now() });
        updated.push(asset.id);
      }
      const state = rewriteStrings(canvas.state, replacements);
      const document = { ...canvas, state, updatedAt: now() }; delete document.projectDir; delete document.canvasDir; delete document.recovered; delete document.recoveryReason;
      await atomicJSON(child(canvas.canvasDir, 'asset-index.json'), state.assets);
      await atomicJSON(child(canvas.canvasDir, 'canvas.json'), document);
      return { updated, ambiguous, missing, state };
    });
  }

  async listAutosaves(projectDir, canvasId) {
    const canvas = await this._canvas(projectDir, canvasId);
    const dir = await directory(child(canvas.canvasDir, 'autosaves'));
    const items = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const target = child(dir, entry.name);
      try { const snapshot = (await readJSON(target, validCanvas)).value; items.push({ name: entry.name, path: target, savedAt: snapshot.updatedAt, kind: snapshot.snapshotKind || 'autosave', nodeCount: snapshot.state.nodes.length, size: (await fs.stat(target)).size }); }
      catch (err) { items.push({ name: entry.name, path: target, invalid: true, error: err.message }); }
    }
    return items.sort((a, b) => b.name.localeCompare(a.name));
  }

  async previewRestore(projectDir, canvasId, snapshotName) {
    validateName(snapshotName);
    const canvas = await this._canvas(projectDir, canvasId);
    return clone((await readJSON(child(canvas.canvasDir, 'autosaves/' + snapshotName), value => validCanvas(value) && value.id === canvasId)).value.state);
  }

  async restoreCanvas(projectDir, canvasId, snapshotName, { asNew = false, name, ownerId } = {}) {
    let state = await this.previewRestore(projectDir, canvasId, snapshotName);
    if (asNew) {
      const canvas = await this.loadCanvas(projectDir, canvasId);
      delete state.shared; delete state.sharing; delete state.sharedCanvasId; delete state.chat;
      if (ownerId) { state.nodes.forEach(node => { node.owner = ownerId; delete node.taskId; delete node.activeTask; delete node.execution; }); state.groups.forEach(group => { group.owner = ownerId; }); }
      // Keep references valid when placing an independent canvas beside the original.
      const replacements = new Map();
      for (const asset of state.assets) {
        const reference = asset.path || asset.asset;
        if (typeof reference === 'string' && !path.isAbsolute(reference) && !/^[a-z]+:/i.test(reference)) replacements.set(reference, child(canvas.canvasDir, reference));
      }
      state = rewriteStrings(state, replacements);
      state.assets.forEach(asset => { asset.external = true; });
      const copy = await this.createCanvas(projectDir, name || canvas.name + ' · 恢复副本', state);
      await copyTreeSafe(child(canvas.canvasDir, 'workflows'), child(copy.canvasDir, 'workflows'));
      return copy;
    }
    const canvas = await this.loadCanvas(projectDir, canvasId);
    if (canvas.state.shared || canvas.state.sharing?.active) throw error('SHARED_RESTORE_REQUIRES_COPY', '共享画布请恢复为独立新画布，避免覆盖其他成员内容。');
    const backupName = now().replace(/[:.]/g, '-') + '-before-restore-' + id().slice(0, 8) + '.json';
    await atomicJSON(child(canvas.canvasDir, 'autosaves/' + backupName), { format: canvas.format, version: canvas.version, id: canvas.id, name: canvas.name, createdAt: canvas.createdAt, updatedAt: now(), snapshotKind: 'before-restore', state: canvas.state }, { backup: false });
    // Existing asset registry is merged by saveCanvas, so later results are not removed.
    await this.saveCanvas(projectDir, canvasId, state);
    return { ...(await this.loadCanvas(projectDir, canvasId)), beforeRestorePath: child(canvas.canvasDir, 'autosaves/' + backupName) };
  }

  async retainWorkflow(projectDir, canvasId, workflow) {
    if (!workflow || workflow.origin !== 'custom' || workflow.gui === undefined || !workflow.api || !workflow.mapping) throw error('CUSTOM_WORKFLOW_REQUIRED', '仅完整的自定义工作流可复制进画布；机器默认工作流不保存到项目。');
    validateName(workflow.id);
    const canvas = await this._canvas(projectDir, canvasId);
    const payload = scrubCredentials({ id: workflow.id, version: workflow.version || 1, origin: 'custom', gui: workflow.gui, api: workflow.api, mapping: workflow.mapping });
    const digest = hash(payload), relative = 'workflows/' + workflow.id + '-' + digest.slice(0, 16);
    const destination = child(canvas.canvasDir, relative);
    return exclusive(destination, async () => {
      await directory(destination, true);
      const target = child(destination, 'workflow.json');
      try { const existing = (await readJSON(target)).value; if (hash(existing) !== digest) throw error('WORKFLOW_CONFLICT', '同版本工作流内容不一致。'); }
      catch (err) { if (err.code !== 'ENOENT') throw err; await atomicJSON(target, payload, { backup: false }); }
      return { id: workflow.id, version: workflow.version || 1, hash: digest, path: relative + '/workflow.json', origin: 'custom' };
    });
  }

  async packageProject(projectDir, destination) { return this._package(projectDir, null, destination); }
  async packageCanvas(projectDir, canvasId, destination) { return this._package(projectDir, canvasId, destination); }

  async _package(projectDir, canvasId, destination) {
    const source = await this._project(projectDir);
    destination = await noLinks(destination);
    if (within(source.projectDir, destination) || within(destination, source.projectDir)) throw error('UNSAFE_DESTINATION', '打包目录不能与源项目相同、包含源项目或位于源项目内。');
    let destinationExisted = false;
    try { destinationExisted = true; if ((await fs.readdir(destination)).length) throw error('DESTINATION_NOT_EMPTY', '打包目标必须是新的空目录。'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; destinationExisted = false; }
    const entries = canvasId ? source.value.canvases.filter(canvas => canvas.id === canvasId) : source.value.canvases;
    if (canvasId && !entries.length) throw error('CANVAS_NOT_FOUND', '找不到要打包的画布。');
    const staging = destination + '.partial-' + id();
    await directory(staging, true);
    const warnings = [];
    try {
      const canvasIds=new Map(entries.map(entry=>[entry.id,id()]));
      const packaged = { ...source.value, id: id(), name: canvasId ? entries[0].name : source.value.name, packagedFrom: source.value.id, createdAt: now(), updatedAt: now(), canvases: entries.map(entry=>({...clone(entry),id:canvasIds.get(entry.id),copiedFromCanvasId:entry.id})) };
      for (const entry of entries) {
        const canvas = await this.loadCanvas(source.projectDir, entry.id);
        const output = child(staging, entry.directory); await directory(output, true);
        for (const type of [...ASSET_DIRS, 'workflows', 'autosaves']) await directory(child(output, type), true);
        const replacements = new Map(), state = clone(canvas.state);
        // Registry includes deleted-card media and generated history; none is silently discarded.
        for (const asset of state.assets) {
          const raw = asset.path || asset.asset;
          if (!raw) continue;
          let actual;
          try { actual = await this.resolveAssetPath(source.projectDir, entry.id, asset); }
          catch (err) { throw error('MISSING_PACKAGE_ASSET', '无法打包素材“' + (asset.title || asset.id) + '”：' + err.message); }
          const digest = await fileHash(actual), type = ASSET_DIRS.includes(asset.type) ? asset.type : mediaType(actual);
          const filename = digest.slice(0, 20) + path.extname(actual).toLowerCase(), relative = type + '/' + filename, target = child(output, relative);
          await noLinks(target);
          try { await fs.copyFile(actual, target, require('node:fs').constants.COPYFILE_EXCL); } catch (err) { if (err.code !== 'EEXIST' || await fileHash(target) !== digest) throw err; }
          if (await fileHash(target) !== digest) throw error('COPY_VERIFY_FAILED', '打包素材校验失败。');
          for (const value of [raw, asset.asset, asset.path, actual]) if (typeof value === 'string') replacements.set(value, relative);
          Object.assign(asset, { asset: relative, path: relative, external: false, sha256: digest });
        }
        let finalState = scrubCredentials(rewriteStrings(state, replacements));
        // Execution configuration remains machine-owned; export dependencies, never credentials.
        delete finalState.connections; delete finalState.credentials;
        // A package is an independent editable copy, not membership in the old LAN session.
        delete finalState.shared; delete finalState.sharing; delete finalState.sharedCanvasId; delete finalState.chat;
        for (const node of finalState.nodes) { if (node.owner && node.owner !== 'me') node.copiedFromOwner = node.owner; node.owner = 'me'; delete node.taskId; delete node.activeTask; delete node.execution; }
        for (const edge of finalState.edges) if (edge.owner) edge.owner = 'me';
        for (const group of finalState.groups) group.owner = 'me';
        for (const asset of finalState.assets) if (asset.owner) { asset.copiedFromOwner = asset.owner; delete asset.owner; }
        const document = { format: canvas.format, version: canvas.version, id: canvasIds.get(canvas.id), copiedFromCanvasId:canvas.id, name: canvas.name, createdAt: canvas.createdAt, updatedAt: now(), autosaveHash: hash(finalState), state: finalState };
        await atomicJSON(child(output, 'canvas.json'), document, { backup: false });
        await atomicJSON(child(output, 'asset-index.json'), finalState.assets, { backup: false });
        const historyFile = child(canvas.canvasDir, 'generation-history.json');
        try {
          const history = scrubCredentials(rewriteStrings((await readJSON(historyFile, Array.isArray)).value, replacements));
          const packagedAssets = new Map(finalState.assets.map(asset => [asset.id, asset]));
          for (const record of history) if (Array.isArray(record.outputs)) record.outputs = record.outputs.map(asset => packagedAssets.has(asset.id) ? { ...asset, ...packagedAssets.get(asset.id) } : asset);
          await atomicJSON(child(output, 'generation-history.json'), history, { backup: false });
        } catch (err) { if (err.code !== 'ENOENT') throw err; }
        const customDir = child(canvas.canvasDir, 'workflows');
        await copyTreeSafe(customDir, child(output, 'workflows'), { sanitize: true });
      }
      const projectWorkflows = child(source.projectDir, 'workflows');
      try { await copyTreeSafe(projectWorkflows, child(staging, 'workflows'), { sanitize: true }); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      await atomicJSON(path.join(staging, PROJECT_FILE), packaged, { backup: false });
      if (destinationExisted) await fs.rmdir(destination); // Verified empty, not recursive.
      await fs.rename(staging, destination);
      return { projectDir: destination, ...packaged, warnings };
    } catch (err) {
      // Preserve partial files for inspection instead of deleting user media on error.
      err.partialDirectory = staging;
      throw err;
    }
  }
}

module.exports = { ProjectStore, validateName, validState, atomicJSON, readJSON, child, within, noLinks, directory, regularFile, copyTreeSafe, scrubCredentials, rewriteStrings, mediaType, fileHash, exclusive };
