'use strict';

// ponytail: one coordinator and bounded polling, not a distributed database.
// Every network mutation crosses the same ownership and epoch checks.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const os = require('node:os');

const CHUNK = 256 * 1024;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_ASSET = 8 * 1024 * 1024 * 1024;
const COLORS = ['#64b5f6', '#f48fb1', '#81c784', '#ffb74d', '#b39ddb', '#4dd0e1', '#dce775', '#ff8a65'];
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(24).toString('base64url');
const publicKey = key => key.export({type:'spki', format:'pem'}).toString();
const keyId = pem => hash(pem).slice(0, 32);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
const denyKeys = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization|credentials?|cookies?|private[-_]?key|environment|env|view|chat|chats|messages|settings|filePath|absolutePath|localPath|path)$/i;
const privateIP = address => {
  const ip = String(address).replace(/^::ffff:/, '');
  return ip === '::1' || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip) || /^(?:fc|fd)[\da-f]{2}:/i.test(ip) || /^fe80:/i.test(ip);
};
function fail(message, code = 'INVALID', status = 400) { const error = new Error(message); error.code = code; error.status = status; return error; }
function scrub(value, depth = 0) {
  if (depth > 30) throw fail('共享内容层级过深');
  if (typeof value === 'string') {
    if (/^(?:[a-z]:[\\/]|\\\\|file:\/\/)/i.test(value)) return undefined;
    return value.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已过滤密钥]');
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => scrub(v, depth + 1)).filter(v => v !== undefined);
  const clean = {};
  for (const [key, val] of Object.entries(value)) {
    if (denyKeys.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    const next = scrub(val, depth + 1); if (next !== undefined) clean[key] = next;
  }
  return clean;
}
function sharedSnapshot(snapshot = {}, owner) {
  const value = scrub({canvasId:snapshot.canvasId || snapshot.id, version:snapshot.version || 1, title:snapshot.title, nodes:snapshot.nodes || [], edges:snapshot.edges || [], groups:snapshot.groups || [], assets:snapshot.assets || []});
  for (const node of value.nodes) {
    if (!node.owner || node.owner === 'me') node.owner = owner;
    const original = (snapshot.nodes || []).find(n => n.id === node.id);
    if (!node.assetId && original?.asset) node.assetId = (snapshot.assets || []).find(a => a.asset === original.asset || a.path === original.asset)?.id;
    if (node.assetId) delete node.asset;
  }
  for (const group of value.groups) if (!group.owner || group.owner === 'me') group.owner = owner;
  return value;
}
async function atomicJSON(filename, value) {
  await fsp.mkdir(path.dirname(filename), {recursive:true});
  const temporary = filename + '.' + random() + '.tmp';
  await fsp.writeFile(temporary, JSON.stringify(value), {mode:0o600});
  try { await fsp.rename(temporary, filename); }
  catch (error) { await fsp.unlink(temporary).catch(() => {}); throw error; }
}
function seal(key, value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return {iv:iv.toString('base64'), data:data.toString('base64'), tag:cipher.getAuthTag().toString('base64')};
}
function unseal(key, box) {
  if (!box || typeof box.iv !== 'string' || typeof box.data !== 'string' || typeof box.tag !== 'string') throw fail('加密消息格式错误', 'AUTH', 401);
  const iv = Buffer.from(box.iv, 'base64'), tag = Buffer.from(box.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw fail('加密消息格式错误', 'AUTH', 401);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString());
  } catch { throw fail('消息身份验证失败', 'AUTH', 401); }
}
function signature(privateKey, value) { return crypto.sign(null, Buffer.from(JSON.stringify(value)), privateKey).toString('base64'); }
function verify(pem, value, sig) {
  try { return crypto.verify(null, Buffer.from(JSON.stringify(value)), pem, Buffer.from(sig, 'base64')); } catch { return false; }
}
function derive(privateKey, peerKey, transcript) {
  const secret = crypto.diffieHellman({privateKey, publicKey:crypto.createPublicKey(peerKey)});
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(hash(JSON.stringify(transcript)), 'hex'), Buffer.from('CreateMore LAN v1'), 32));
}
async function bodyJSON(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw fail('消息过大', 'TOO_LARGE', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail('JSON 格式错误'); }
}
function send(res, status, value) { res.writeHead(status, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff'}); res.end(JSON.stringify(value)); }
async function resolveLAN(url) {
  let parsed; try { parsed = new URL(url); } catch { throw fail('请输入有效的局域网共享地址'); }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) throw fail('仅支持无凭据的 http 局域网地址');
  const addresses = await dns.lookup(parsed.hostname.replace(/^\[|\]$/g, ''), {all:true});
  if (!addresses.length || addresses.some(item => !privateIP(item.address))) throw fail('共享地址必须位于本机或局域网', 'LAN_ONLY');
  return {url:parsed.origin, address:addresses[0].address, family:addresses[0].family};
}
async function requestJSON(endpoint, route, value, timeout = 6000) {
  const target = await resolveLAN(endpoint), url = new URL(target.url + route), data = value === undefined ? null : Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const req = http.request({hostname:target.address, port:url.port || 80, family:target.family, path:url.pathname, method:data ? 'POST' : 'GET', timeout, headers:{host:url.host, ...(data ? {'content-type':'application/json', 'content-length':data.length} : {})}}, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 32 * MAX_BODY) { req.destroy(fail('响应过大')); return; } chunks.push(chunk); });
      res.on('end', () => { try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (res.statusCode >= 400) reject(fail(result.message || '共享连接失败', result.code || 'NETWORK', res.statusCode)); else resolve(result); } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(fail('共享连接超时', 'NETWORK', 503))); req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function fileHash(filename) { const digest = crypto.createHash('sha256'); for await (const part of fs.createReadStream(filename)) digest.update(part); return digest.digest('hex'); }
function assetMeta(meta, owner) {
  if (!safeId(meta?.id) || !/^[a-f0-9]{64}$/.test(meta.sha256) || !Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > MAX_ASSET) throw fail('素材标识、大小或校验值无效');
  return {id:meta.id, name:path.basename(String(meta.name || meta.title || meta.id).replace(/\\/g, '/')), type:['image','video','audio','text','workflow','other'].includes(meta.type) ? meta.type : 'other', size:meta.size, sha256:meta.sha256, owner};
}
function validateNode(node) {
  if(!safeId(node.id)||typeof node.type!=='string'||!node.type||node.type.length>100||node.owner==='me'||!safeId(node.owner))throw fail('卡片身份或类型无效');
  for(const key of ['x','y','w','h'])if(node[key]!==undefined&&(!Number.isFinite(node[key])||Math.abs(node[key])>10000000||(['w','h'].includes(key)&&node[key]<=0)))throw fail('卡片位置或尺寸无效');
  for(const key of ['title','prompt','content'])if(node[key]!==undefined&&typeof node[key]!=='string')throw fail('卡片文本格式无效');
}

class CollaborationService {
  constructor({dataDir, getSnapshot = () => ({}), applySnapshot = () => {}, listAssets = () => [], readAsset, writeAsset, onEvent = () => {}, pollMs = 1200, timeoutMs = 6000} = {}) {
    if (!dataDir) throw new Error('CollaborationService requires dataDir');
    this.dataDir = path.resolve(dataDir); this.getSnapshot = getSnapshot; this.applySnapshot = applySnapshot; this.listAssets = listAssets; this.readAsset = readAsset; this.writeAsset = writeAsset; this.onEvent = onEvent;
    this.pollMs = Math.max(100, pollMs); this.timeoutMs = timeoutMs; this.mode = 'idle'; this.sessions = new Map(); this.peerRemotes = new Map(); this.rpcExtensions = new Map(); this.challenges = new Map(); this.rateLimit = new Map(); this.assets = new Map(); this.seenOps = new Map(); this.lock = Promise.resolve(); this.persistLock=Promise.resolve(); this.syncing = false; this.lastError = null; this.failureCount = 0; this.ready = this._initialize();
  }
  async _initialize() {
    await fsp.mkdir(this.dataDir, {recursive:true});
    const filename = path.join(this.dataDir, 'identity.json');
    try { this.identity = JSON.parse(await fsp.readFile(filename, 'utf8')); crypto.createPrivateKey(this.identity.privateKey); if (keyId(this.identity.publicKey) !== this.identity.id) throw new Error('Identity mismatch'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw fail('局域网身份文件损坏；不能自动更换身份，否则会失去旧卡片权限', 'IDENTITY');
      const pair = crypto.generateKeyPairSync('ed25519'), pem = publicKey(pair.publicKey), id = keyId(pem);
      this.identity = {id, name:os.hostname(), color:COLORS[parseInt(id.slice(0,8), 16) % COLORS.length], publicKey:pem, privateKey:pair.privateKey.export({type:'pkcs8', format:'pem'}).toString()};
      await atomicJSON(filename, this.identity);
    }
    try { this.saved = JSON.parse(await fsp.readFile(path.join(this.dataDir, 'session.json'), 'utf8')); for (const asset of this.saved.assets || []) this.assets.set(asset.meta.id, asset); } catch (error) { if (error.code !== 'ENOENT') throw fail('共享恢复记录损坏；原素材未删除', 'STATE'); }
    this.state = this.saved?.state || null; this.pins = this.saved?.pins || {}; this.vote = this.saved?.vote || null; this.prepared = this.saved?.prepared || null;
    if (this.state && !this.state.stopped) this.mode = 'disconnected';
  }
  _identity() { const {privateKey, ...identity} = this.identity; return clone(identity); }
  _emit(type, detail = {}) { try { this.onEvent({type, ...detail, status:this.status()}); } catch {} }
  status() {
    return {mode:this.mode, identity:this.identity ? this._identity() : null, sessionId:this.state?.sessionId || null, canvasId:this.state?.snapshot?.canvasId || null, epoch:this.state?.epoch || 0, revision:this.state?.revision || 0, url:this.mode === 'hosting' ? this.url : (this.remote?.url || this.url || null), localUrl:this.url || null, hostId:this.state?.hostId || null, pinnedHostId:this.remote?.url ? (this.pins?.[this.remote.url] || null) : null, members:clone(this.state?.members || []), passwordRequired:!!this.state?.passwordRequired, syncing:this.syncing, assetsTotal:this.state?.manifest?.length || 0, assetsReady:(this.state?.manifest || []).filter(meta => this.assets.get(meta.id)?.meta.sha256 === meta.sha256).length, pendingWrite:!!this.prepared, lastError:this.lastError, takeoverPolicy:'majority-and-epoch', stopped:!!this.state?.stopped};
  }
  async _persist() { const write=()=>atomicJSON(path.join(this.dataDir, 'session.json'), {state:this.state, pins:this.pins, vote:this.vote, prepared:this.prepared, assets:[...this.assets.values()]});const result=this.persistLock.then(write,write);this.persistLock=result.catch(()=>{});return result; }
  async _apply(reason) {
    await this.applySnapshot(clone(this.state.snapshot), {reason, revision:this.state.revision, epoch:this.state.epoch, identity:this._identity(), members:clone(this.state.members)});
  }
  _serial(fn) { const work = this.lock.then(fn, fn); this.lock = work.catch(() => {}); return work; }
  async _listen(port = 47771, host = '0.0.0.0') {
    if (this.server) return;
    if (!['0.0.0.0','127.0.0.1','::1'].includes(host) && !privateIP(host)) throw fail('监听地址必须是局域网地址');
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.headersTimeout = 15000; this.server.requestTimeout = 15000; this.server.maxConnections = 64;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, host, () => { this.server.off('error', reject); resolve(); }); }).catch(error => { this.server = null; throw error; });
    const actual = this.server.address(); this.listenHost = host; this.port = actual.port;
    const lan = Object.values(os.networkInterfaces()).flat().find(item => item.family === 'IPv4' && !item.internal && privateIP(item.address))?.address;
    const address = host === '0.0.0.0' ? (lan || '127.0.0.1') : host;
    this.url = `http://${address.includes(':') ? '['+address+']' : address}:${actual.port}`;
  }
  async _closeServer() { const server = this.server; this.server = null; if (server) { server.closeIdleConnections?.(); await new Promise(resolve => server.close(resolve)); } }
  _publicInfo() { return {protocol:1, host:this._identity(), sessionId:this.state?.sessionId, canvasId:this.state?.snapshot?.canvasId, epoch:this.state?.epoch, revision:this.state?.revision, mode:this.mode, stopped:!!this.state?.stopped, passwordRequired:!!this.state?.passwordRequired, salt:this.authSalt, fingerprint:this.identity.id}; }
  async startHosting({port = 47771, host = '0.0.0.0', password = '', canvasId} = {}) {
    await this.ready; if (!['idle','stopped','disconnected'].includes(this.mode)) throw fail('请先离开当前共享会话');
    if (this.state && !this.state.stopped && (!canvasId || canvasId === this.state.snapshot.canvasId)) throw fail('已有共享会话尚未结束，请先重连、接管或另存独立画布', 'SESSION_EXISTS');
    const snapshot = sharedSnapshot(await this.getSnapshot(), this.identity.id); snapshot.canvasId = canvasId || snapshot.canvasId || crypto.randomUUID();
    this.state = {sessionId:crypto.randomUUID(), epoch:1, revision:0, hostId:this.identity.id, stopped:false, passwordRequired:!!password, snapshot, manifest:[], members:[{...this._identity(), url:null, active:true}], updatedAt:Date.now()}; this.initialAssetIds = new Set(); this.prepared = null; this.vote = null;
    this.authSalt = random(); this.passwordVerifier = password ? crypto.scryptSync(password, this.authSalt, 32) : null;
    await this._collectInitialAssets(); await this._listen(port, host); this.state.members[0].url = this.url; this.mode = 'hosting'; await this._apply('host'); await this._persist(); this._emit('hosting'); return this.status();
  }
  async _collectInitialAssets() {
    for (const meta of await this.listAssets()) {
      if (!this.readAsset) throw fail('共享存在素材，但未接入素材读取服务', 'ASSET_READER');
      const source = await this.readAsset(meta.id);
      await this._storeAsset(meta, source, this.identity.id);
    }
    this.state.manifest = [...this.assets.values()].filter(a => (this.state.snapshot.assets || []).some(s => s.id === a.meta.id) || this.initialAssetIds?.has(a.meta.id)).map(a => a.meta);
    // The provider inventory, not only visible nodes, includes retained generation history.
    if (this.initialAssetIds) this.state.manifest = [...this.initialAssetIds].map(id => this.assets.get(id).meta);
    this.state.snapshot.assets = clone(this.state.manifest);
  }
  async _storeAsset(meta, source, owner) {
    if (!Buffer.isBuffer(source) && typeof source !== 'string') throw fail('素材读取必须返回 Buffer 或绝对文件路径', 'ASSET_READER');
    const size = Buffer.isBuffer(source) ? source.length : (await fsp.stat(source)).size;
    const sha256 = Buffer.isBuffer(source) ? hash(source) : await fileHash(source);
    const clean = assetMeta({...meta,size,sha256}, owner), destination = path.join(this.dataDir, 'shared-assets', sha256);
    await fsp.mkdir(path.dirname(destination), {recursive:true});
    if (!fs.existsSync(destination)) { if (Buffer.isBuffer(source)) await fsp.writeFile(destination, source); else await fsp.copyFile(source, destination); }
    if (await fileHash(destination) !== sha256) throw fail('本地共享素材校验失败', 'ASSET_HASH');
    this.assets.set(clean.id, {meta:clean, filename:destination}); if (!this.initialAssetIds) this.initialAssetIds = new Set(); this.initialAssetIds.add(clean.id); return clean;
  }
  async _handle(req, res) {
    try {
      if (!privateIP(req.socket.remoteAddress)) throw fail('仅接受局域网连接', 'LAN_ONLY', 403);
      if (req.headers.origin) throw fail('不接受网页跨源调用', 'ORIGIN', 403);
      const route = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && route === '/info') return send(res, 200, this._publicInfo());
      if (req.method !== 'POST') throw fail('请求不存在', 'NOT_FOUND', 404);
      const input = await bodyJSON(req);
      if (route === '/challenge') return send(res, 200, this._challenge(input, req.socket.remoteAddress));
      if (route === '/join') return send(res, 200, await this._acceptJoin(input));
      if (route === '/rpc') {
        const session = this.sessions.get(input.sid);
        if (!session || session.expires < Date.now()) throw fail('会话验证已失效，请重新输入当前密码加入', 'REAUTH', 401);
        const message = unseal(session.key, input.box);
        if (message.token !== session.token || !safeId(message.requestId) || !Number.isSafeInteger(message.sequence) || message.sequence <= 0 || message.sequence <= session.highest-4096 || session.sequences.has(message.sequence) || session.seen.has(message.requestId)) throw fail('请求重复或身份无效', 'AUTH', 401);
        session.highest=Math.max(session.highest,message.sequence);session.sequences.add(message.sequence);for(const number of session.sequences)if(number<=session.highest-4096)session.sequences.delete(number);
        session.seen.add(message.requestId); if (session.seen.size > 4096) session.seen.delete(session.seen.values().next().value);
        let result;
        try { result = {ok:true, value:await this._rpc(message, session.memberId)}; }
        catch (error) { result = {ok:false, error:{message:error.message, code:error.code || 'ERROR', status:error.status || 400}}; }
        return send(res, 200, {box:seal(session.key, {requestId:message.requestId, ...result})});
      }
      throw fail('请求不存在', 'NOT_FOUND', 404);
    } catch (error) { if (!res.headersSent) send(res, error.status || 500, {message:error.status ? error.message : '共享服务处理失败，请查看本机诊断', code:error.code || 'SERVER'}); else res.destroy(); }
  }
  _challenge(input, address) {
    if (!['hosting','joined','disconnected'].includes(this.mode) || this.state?.stopped) throw fail('共享已经停止', 'STOPPED', 410);
    const rate = this.rateLimit.get(address) || {count:0, reset:Date.now()+60000}; if (rate.reset < Date.now()) { rate.count = 0; rate.reset = Date.now()+60000; } if (++rate.count > 30) throw fail('验证尝试过多，请稍后重试', 'RATE_LIMIT', 429); this.rateLimit.set(address, rate);
    if (typeof input.publicKey !== 'string' || input.publicKey.length > 1000 || typeof input.ephemeral !== 'string' || input.ephemeral.length > 1000) throw fail('身份格式无效');
    const identityKey = crypto.createPublicKey(input.publicKey), exchangeKey = crypto.createPublicKey(input.ephemeral);
    if (identityKey.asymmetricKeyType !== 'ed25519' || exchangeKey.asymmetricKeyType !== 'x25519') throw fail('身份密钥类型无效');
    const pair = crypto.generateKeyPairSync('x25519'), id = random();
    const transcript = {id, sessionId:this.state.sessionId, epoch:this.state.epoch, hostId:this.identity.id, clientId:keyId(input.publicKey), clientPublicKey:input.publicKey, clientEphemeral:input.ephemeral, serverEphemeral:publicKey(pair.publicKey), salt:this.authSalt, passwordRequired:!!this.state.passwordRequired};
    this.challenges.set(id, {transcript, privateKey:pair.privateKey, expires:Date.now()+30000, name:String(input.name || '成员').slice(0,64)});
    for (const [key,value] of this.challenges) if (value.expires < Date.now()) this.challenges.delete(key);
    return {...transcript, signature:signature(this.identity.privateKey, transcript)};
  }
  async _acceptJoin(input) {
    const pending = this.challenges.get(input.id); this.challenges.delete(input.id);
    if (!pending || pending.expires < Date.now()) throw fail('验证请求已过期', 'AUTH', 401);
    const {transcript} = pending;
    if (!verify(transcript.clientPublicKey, {transcript, proof:input.proof || null}, input.signature)) throw fail('成员身份签名无效', 'AUTH', 401);
    if (this.passwordVerifier) { const expected = crypto.createHmac('sha256', this.passwordVerifier).update(JSON.stringify(transcript)).digest('hex'); const actual = Buffer.from(String(input.proof || ''), 'hex'); if (actual.length !== 32 || !crypto.timingSafeEqual(Buffer.from(expected,'hex'), actual)) throw fail('共享密码错误', 'PASSWORD', 401); }
    else if (this.mode !== 'hosting') {
      // Peers authenticate only established member keys; a takeover never learns a host's password.
      if (!this.state.members.some(m => m.id === transcript.clientId && m.publicKey === transcript.clientPublicKey)) throw fail('非协调者仅接受已验证成员', 'AUTH', 403);
    }
    const preferred = COLORS[parseInt(transcript.clientId.slice(0,8),16) % COLORS.length], used = new Set(this.state.members.map(m => m.color));
    const color = !used.has(preferred) ? preferred : (COLORS.find(c => !used.has(c)) || `hsl(${parseInt(transcript.clientId.slice(0,8),16)%360} 70% 70%)`);
    const member = {id:transcript.clientId, publicKey:transcript.clientPublicKey, name:pending.name, color, url:null, active:true};
    if (this.mode === 'hosting' && !this.state.members.some(m => m.id === member.id)) { member.active = false; this.state.members.push(member); await this._persist(); }
    const key = derive(pending.privateKey, transcript.clientEphemeral, transcript), sid = random(), token = random();
    for(const [id,session]of this.sessions)if(session.expires<Date.now())this.sessions.delete(id);
    if(this.sessions.size>=1024)throw fail('共享验证会话数量已达到上限，请稍后重试','SESSION_LIMIT',429);
    this.sessions.set(sid, {memberId:member.id, key, token, expires:Date.now()+12*60*60*1000, seen:new Set(),sequences:new Set(),highest:0});
    return {sid, box:seal(key, {token, state:clone(this.state)})};
  }
  async _connect(url, password = '', expectedId) {
    const target = await resolveLAN(url), info = await requestJSON(target.url, '/info', undefined, this.timeoutMs);
    if (info.protocol !== 1 || keyId(info.host?.publicKey || '') !== info.host?.id || info.stopped) throw fail('共享会话不可用', info.stopped ? 'STOPPED' : 'PROTOCOL', 410);
    const pin = expectedId || this.pins[target.url]; if (pin && info.host.id !== pin) throw fail('共享主机身份发生变化，拒绝自动信任', 'HOST_CHANGED', 409);
    const pair = crypto.generateKeyPairSync('x25519');
    const challenge = await requestJSON(target.url, '/challenge', {publicKey:this.identity.publicKey, ephemeral:publicKey(pair.publicKey), name:this.identity.name}, this.timeoutMs);
    const {signature:sig, ...transcript} = challenge;
    if (transcript.hostId !== info.host.id || transcript.clientId !== this.identity.id || transcript.clientEphemeral !== publicKey(pair.publicKey) || !verify(info.host.publicKey, transcript, sig)) throw fail('共享主机签名验证失败', 'AUTH', 401);
    const verifier = transcript.passwordRequired ? crypto.scryptSync(password, transcript.salt, 32) : null;
    const proof = verifier ? crypto.createHmac('sha256', verifier).update(JSON.stringify(transcript)).digest('hex') : null;
    const accepted = await requestJSON(target.url, '/join', {id:transcript.id, proof, signature:signature(this.identity.privateKey,{transcript,proof})}, this.timeoutMs);
    const key = derive(pair.privateKey, transcript.serverEphemeral, transcript), result = unseal(key, accepted.box);
    this.pins[target.url] = info.host.id;
    return {url:target.url, hostId:info.host.id, sid:accepted.sid, key, token:result.token, state:result.state};
  }
  async join({url, password = '', port = 0, host = '0.0.0.0', expectedHostId} = {}) {
    await this.ready; if (this.mode === 'hosting') throw fail('请先退出当前发起的共享');
    this._stopPoll(); const remote = await this._connect(url, password, expectedHostId);
    if (this.state && this.mode === 'disconnected' && !this.state.stopped && remote.state.sessionId !== this.state.sessionId) throw fail('远端已是另一共享会话，请先保留独立副本再加入', 'SESSION_CHANGED', 409);
    this.remote = remote; this.state = remote.state; this.authSalt = random(); this.passwordVerifier = null; this.mode = 'joined'; this.lastError = null;
    await this._listen(port, host);
    const joined = await this._request('member.endpoint', {url:this.url}); this.state = joined;
    await this._apply('join'); await this._syncAssets(); await this._persist(); this._startPoll(); this._emit('joined'); return this.status();
  }
  async _request(method, params = {}, remote = this.remote, epoch = this.state?.epoch) {
    if (!remote) throw fail('尚未加入共享', 'OFFLINE');
    remote.sequence=(remote.sequence||0)+1;const requestId = crypto.randomUUID(), response = await requestJSON(remote.url, '/rpc', {sid:remote.sid, box:seal(remote.key,{token:remote.token, requestId, sequence:remote.sequence, method, params, sessionId:this.state?.sessionId, epoch})}, this.timeoutMs);
    const message = unseal(remote.key, response.box); if (message.requestId !== requestId) throw fail('响应编号不匹配', 'AUTH', 401);
    if (!message.ok) throw fail(message.error.message, message.error.code, message.error.status); return message.value;
  }
  async _peerRequest(member,method,params) {
    let remote = this.remote?.hostId===member.id&&this.remote.url===member.url ? this.remote : this.peerRemotes.get(member.id);
    if (!remote || remote.url !== member.url) { remote = await this._connect(member.url,'',member.id); this.peerRemotes.set(member.id,remote); }
    try { return {remote,value:await this._request(method,params,remote)}; }
    catch (error) { if (!['REAUTH','AUTH'].includes(error.code)) throw error; this.peerRemotes.delete(member.id); remote = await this._connect(member.url,'',member.id); this.peerRemotes.set(member.id,remote); return {remote,value:await this._request(method,params,remote)}; }
  }
  async _rpc(message, memberId) {
    if (message.sessionId !== this.state.sessionId) throw fail('共享会话已变化', 'SESSION_CHANGED', 409);
    if (message.epoch !== this.state.epoch && !['election.vote','election.commit'].includes(message.method)) throw fail('协调者版本已变化，请重新连接', 'EPOCH', 409);
    const extension=this.rpcExtensions.get(message.method);
    if (this.state.stopped && message.method !== 'poll' && !extension?.allowAfterStop) throw fail('共享已经主动停止', 'STOPPED', 410);
    const params = message.params || {};
    if(extension){if(!this.state.members.some(m=>m.id===memberId&&m.active))throw fail('成员已离开，不能调用共享设备','MEMBER',403);return extension.handler(params,{memberId,sessionId:this.state.sessionId,canvasId:this.state.snapshot.canvasId,epoch:this.state.epoch});}
    if (message.method === 'poll') return this.state.revision === params.revision && !this.state.stopped ? {unchanged:true, epoch:this.state.epoch} : {state:clone(this.state)};
    if (message.method === 'election.vote') return this._serial(() => this._vote(params, memberId));
    if (message.method === 'election.commit') return this._serial(() => this._commitElection(params, memberId));
    if (message.method === 'replica.prepare') return this._serial(() => this._prepareReplica(params, memberId));
    if (message.method === 'replica.commit') return this._serial(() => this._commitReplica(params, memberId));
    if (this.mode !== 'hosting') throw fail('仅当前协调者接受画布修改', 'NOT_HOST', 409);
    if (!this.state.members.some(m => m.id === memberId && (m.active || message.method === 'member.endpoint'))) throw fail('成员已离开，需重新加入', 'MEMBER', 403);
    if (message.method === 'publish') return this._serial(() => this._mutate(params, memberId));
    if (message.method === 'member.endpoint') {
      return this._serial(async () => { const target = await resolveLAN(params.url), next = clone(this.state); const member = next.members.find(m => m.id === memberId); member.url = target.url; member.active = true; next.revision++; await this._commitState(next,'member-joined'); return clone(this.state); });
    }
    if (message.method === 'member.leave') return this._serial(async () => { const next = clone(this.state); next.members.find(m => m.id === memberId).active = false; next.revision++; await this._commitState(next,'member-left'); this._emit('member-left',{memberId}); return true; });
    if (message.method === 'asset.read') return this._readChunk(params);
    if (message.method === 'asset.begin') return this._beginUpload(params, memberId);
    if (message.method === 'asset.chunk') return this._writeChunk(params, memberId);
    if (message.method === 'asset.commit') return this._serial(() => this._commitUpload(params, memberId));
    throw fail('不支持的共享操作');
  }
  registerRPC(name,handler,{allowAfterStop=false}={}){
    if(!/^resource\.[a-z.]+$/.test(name)||typeof handler!=='function'||this.rpcExtensions.has(name))throw fail('共享扩展名称无效或重复');
    this.rpcExtensions.set(name,{handler,allowAfterStop});return()=>this.rpcExtensions.delete(name);
  }
  async callMember(memberId,method,params={}){
    await this.ready;if(!this.rpcExtensions.has(method))throw fail('本机未登记该共享能力','UNSUPPORTED');
    if(memberId===this.identity.id)return this._rpc({sessionId:this.state?.sessionId,epoch:this.state?.epoch,method,params},this.identity.id);
    const member=this.state?.members.find(m=>m.id===memberId&&m.active);if(!member?.url)throw fail('共享设备不在线或没有有效地址','MEMBER',404);
    return (await this._peerRequest(member,method,params)).value;
  }
  async sharedAssetFile(id){
    await this.ready;const meta=this.state?.manifest.find(m=>m.id===id),asset=this.assets.get(id);if(!meta||!asset||asset.meta.sha256!==meta.sha256)throw fail('共享素材尚未同步完整','ASSET_MISSING',404);
    if(await fileHash(asset.filename)!==meta.sha256)throw fail('共享素材本地副本校验失败','ASSET_HASH');return {meta:clone(meta),path:asset.filename};
  }
  async publish(operation) {
    await this.ready; if (this.state?.stopped) throw fail('共享已经主动停止', 'STOPPED', 410);
    if (this.mode === 'hosting') return this._serial(() => this._mutate(operation,this.identity.id));
    if (this.mode !== 'joined') throw fail('共享已断线；改动未发送，请重连后重试或另存独立画布', 'OFFLINE', 503);
    const result = await this._request('publish', {...operation, idempotencyKey:operation.idempotencyKey || crypto.randomUUID()}); this.state = result.state; await this._apply('publish'); await this._syncAssets(); await this._persist(); return result;
  }
  async _mutate(operation, actor) {
    if (this.state.stopped || this.mode !== 'hosting' || (this.vote && this.vote.epoch > this.state.epoch)) throw fail('当前协调者不能继续写入', 'FENCED', 409);
    const key = operation.idempotencyKey, fingerprint = hash(JSON.stringify({...operation,idempotencyKey:undefined,baseRevision:undefined}));
    const prior = key && (this.state.appliedOps || []).find(op => op.key === key && op.actor === actor);
    if (prior) { if (prior.fingerprint !== fingerprint) throw fail('同一个重试编号不能用于不同修改','IDEMPOTENCY_CONFLICT',409); return {revision:this.state.revision,state:clone(this.state),replayed:true}; }
    if (operation.baseRevision !== undefined && operation.baseRevision !== this.state.revision) throw fail('画布已变化，请刷新后重试；未覆盖其他成员内容', 'CONFLICT', 409);
    const next = clone(this.state.snapshot), ownNode = id => { const node = next.nodes.find(n => n.id === id); if (!node) throw fail('节点不存在','NOT_FOUND',404); if (node.owner !== actor) throw fail('只能修改自己的卡片','OWNERSHIP',403); return node; };
    const operations = operation.type === 'batch' ? operation.operations : [operation];
    if (!Array.isArray(operations) || !operations.length || operations.length > 1000) throw fail('批量操作必须包含 1 至 1000 个修改');
    for (const operation of operations) { switch (operation.type) {
      case 'node.create': { const node = scrub(operation.node); if (!safeId(node?.id) || next.nodes.some(n => n.id === node.id)) throw fail('节点标识无效或重复'); node.owner = actor; next.nodes.push(node); break; }
      case 'node.update': { const node = ownNode(operation.id), patch = scrub(operation.patch || {}); if ('owner' in patch && patch.owner !== actor || 'id' in patch && patch.id !== node.id) throw fail('不能改变卡片身份或所有者','OWNERSHIP',403); Object.assign(node,patch,{id:node.id,owner:actor}); break; }
      case 'node.delete': { ownNode(operation.id); next.nodes = next.nodes.filter(n => n.id !== operation.id); next.edges = next.edges.filter(e => e.from !== operation.id && e.to !== operation.id); next.groups.forEach(g => { g.members = g.members.filter(id => id !== operation.id); }); next.groups = next.groups.filter(g => g.members.length); break; }
      case 'edge.create': { const edge = scrub(operation.edge); if (!safeId(edge?.id) || next.edges.some(e => e.id === edge.id)) throw fail('连线标识无效或重复'); ownNode(edge.to); if (!next.nodes.some(n => n.id === edge.from)) throw fail('来源卡片不存在'); if (edge.from === edge.to) throw fail('不能连接自己'); const seen = new Set(), visit = id => { if (id === edge.from) return true; if (seen.has(id)) return false; seen.add(id); return next.edges.filter(e => e.from === id).some(e => visit(e.to)); }; if (visit(edge.to)) throw fail('连接会形成循环依赖'); edge.owner = actor; next.edges.push(edge); break; }
      case 'edge.delete': { const edge = next.edges.find(e => e.id === operation.id); if (!edge) throw fail('连线不存在'); ownNode(edge.to); next.edges = next.edges.filter(e => e.id !== operation.id); break; }
      case 'group.upsert': { const group = scrub(operation.group); if (!safeId(group?.id) || !Array.isArray(group.members) || !group.members.length || new Set(group.members).size!==group.members.length) throw fail('分组格式无效'); for (const id of group.members) ownNode(id); const index = next.groups.findIndex(g => g.id === group.id); if (index >= 0 && next.groups[index].owner !== actor) throw fail('只能修改自己的分组','OWNERSHIP',403); group.owner = actor; if (index >= 0) next.groups[index] = group; else next.groups.push(group); break; }
      case 'group.delete': { const group = next.groups.find(g => g.id === operation.id); if (!group || group.owner !== actor) throw fail('只能修改自己的分组','OWNERSHIP',403); next.groups = next.groups.filter(g => g.id !== operation.id); break; }
      default: throw fail('不支持的画布共享操作；私人视图、对话及资源密钥不广播');
    } }
    for(const node of next.nodes)validateNode(node);
    const appliedOps = [...(this.state.appliedOps || []),...(key ? [{key,actor,fingerprint}] : [])].slice(-1000);
    await this._commitState({...this.state, snapshot:next, revision:this.state.revision+1, appliedOps, updatedAt:Date.now()},'remote-operation');
    const result = {revision:this.state.revision,state:clone(this.state)};
    this._emit('operation',{actor,operationType:operation.type}); return result;
  }
  async _commitState(next, reason) {
    if (this.prepared && hash(JSON.stringify(this.prepared.state)) !== hash(JSON.stringify(next))) throw fail('上一笔共享写入确认不完整，须先恢复确认，不能继续覆盖','UNCERTAIN_WRITE',409);
    if (this.vote && this.vote.epoch > this.state.epoch) throw fail('本机已确认更高协调周期，旧协调者不能写入','FENCED',409);
    const prepared = this.prepared || {state:clone(next), baseRevision:this.state.revision, reason, digest:hash(JSON.stringify(next))};
    if (!prepared.signature) prepared.signature = signature(this.identity.privateKey,{state:prepared.state,baseRevision:prepared.baseRevision,digest:prepared.digest});
    this.prepared = prepared; await this._persist();
    const current = this.state.members.filter(m => m.active), future = next.members.filter(m => m.active), contacted = new Map(), acknowledgements = new Set([this.identity.id]);
    const peers = new Map([...current,...future].filter(m => m.id !== this.identity.id && m.url).map(m => [m.id,m]));
    await Promise.all([...peers.values()].map(async member => {
      try { const {remote} = await this._peerRequest(member,'replica.prepare',prepared); contacted.set(member.id,remote); acknowledgements.add(member.id); }
      catch (error) { this._emit('replica-unavailable',{memberId:member.id,code:error.code || 'NETWORK'}); }
    }));
    const quorum = roster => roster.filter(m => acknowledgements.has(m.id)).length >= Math.floor(roster.length/2)+1;
    if (!quorum(current) || !quorum(future)) throw fail('共享写入未取得多数成员确认；本次保留为待确认状态，不能作为成功或继续写入。请重连后恢复。','NO_QUORUM',409);
    const previous = this.state; this.state = clone(next); this.prepared = null;
    try { await this._persist(); await this._apply(reason); }
    catch (error) { this.state = previous; this.prepared = prepared; await this._persist().catch(() => {}); throw fail('共享写入已获确认，但本机保存或应用失败；需要恢复，不能重新提交','UNCERTAIN_WRITE',500); }
    await Promise.all([...contacted.values()].map(remote => this._request('replica.commit',{digest:prepared.digest,revision:next.revision},remote).catch(() => {})));
  }
  async _prepareReplica(prepared,actor) {
    if (actor !== this.state.hostId || this.vote?.epoch > this.state.epoch) throw fail('旧协调者写入已隔离','FENCED',409);
    const host = this.state.members.find(m => m.id === actor), next = prepared.state;
    if (!host || next?.sessionId !== this.state.sessionId || next.epoch !== this.state.epoch || prepared.baseRevision !== this.state.revision || next.revision !== this.state.revision+1 || prepared.digest !== hash(JSON.stringify(next)) || !verify(host.publicKey,{state:next,baseRevision:prepared.baseRevision,digest:prepared.digest},prepared.signature)) throw fail('复制版本或签名不匹配','REPLICA_CONFLICT',409);
    if (this.prepared && this.prepared.digest !== prepared.digest) throw fail('已有另一笔未确认写入','UNCERTAIN_WRITE',409);
    this.prepared = clone(prepared); await this._persist(); return {prepared:true,digest:prepared.digest};
  }
  async _commitReplica({digest,revision},actor) {
    if (actor !== this.state.hostId || this.vote?.epoch > this.state.epoch || !this.prepared || this.prepared.digest !== digest || this.prepared.state.revision !== revision) throw fail('复制提交不存在或已被隔离','REPLICA_CONFLICT',409);
    this.state = this.prepared.state; this.prepared = null; await this._persist(); await this._apply('replica-commit'); return true;
  }
  async recoverPending() {
    await this.ready; if (this.mode !== 'hosting') throw fail('仅协调者可恢复待确认写入','NOT_HOST',403);
    if (this.prepared) await this._serial(() => this._commitState(this.prepared.state,this.prepared.reason || 'recovered-write')); return this.status();
  }
  _startPoll() { this._stopPoll(); this.pollTimer = setInterval(() => this.syncNow().catch(() => {}),this.pollMs); this.pollTimer.unref?.(); }
  _stopPoll() { if (this.pollTimer) clearInterval(this.pollTimer); this.pollTimer = null; }
  async syncNow() {
    if (this.polling || !['joined','disconnected'].includes(this.mode) || !this.remote) return this.status(); this.polling = true;
    try {
      const result = await this._request('poll',{revision:this.state.revision});
      if (result.state) {
        if (result.state.epoch < this.state.epoch) throw fail('旧协调者数据已隔离','EPOCH',409);
        if (this.vote?.epoch > result.state.epoch) throw fail('本机已确认新的协调周期，旧主数据不再应用','FENCED',409);
        this.state = result.state; if (this.prepared && this.state.revision >= this.prepared.state.revision) this.prepared = null; if (this.state.stopped) { this.mode = 'stopped'; this._stopPoll(); await this._persist(); this._emit('stopped'); return this.status(); }
        await this._apply('sync'); await this._persist();
      }
      await this._syncAssets(); this.mode = 'joined'; this.lastError = null; this.failureCount = 0;
    } catch (error) { this.failureCount++; this.lastError = {code:error.code || 'NETWORK', message:error.message}; this.mode = error.code === 'STOPPED' ? 'stopped' : 'disconnected'; if (['REAUTH','STOPPED','EPOCH','SESSION_CHANGED'].includes(error.code)) this._stopPoll(); this._emit('disconnected',{error:this.lastError}); throw error; }
    finally { this.polling = false; }
    return this.status();
  }
  async _readChunk({id,offset = 0}) {
    const asset = this.assets.get(id); if (!asset || !this.state.manifest.some(m => m.id === id)) throw fail('共享素材不存在','ASSET_MISSING',404);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > asset.meta.size) throw fail('素材读取位置无效');
    const handle = await fsp.open(asset.filename,'r'); const buffer = Buffer.alloc(Math.min(CHUNK,asset.meta.size-offset));
    try { const {bytesRead} = await handle.read(buffer,0,buffer.length,offset); return {meta:asset.meta,offset,data:buffer.subarray(0,bytesRead).toString('base64')}; } finally { await handle.close(); }
  }
  async _syncAssets() {
    if (this.assetSync) return this.assetSync;
    this.assetSync = Promise.resolve().then(async () => {
      this.syncing = true; this._emit('assets-syncing');
      try {
        for (const meta of this.state.manifest || []) {
          const have = this.assets.get(meta.id); if (have?.meta.sha256 === meta.sha256 && fs.existsSync(have.filename) && await fileHash(have.filename) === meta.sha256) continue;
          const filename = await this._part(meta.sha256); let offset = (await fsp.stat(filename)).size; if (offset > meta.size) { await fsp.truncate(filename,0); offset = 0; }
          while (offset < meta.size) { const chunk = await this._request('asset.read',{id:meta.id,offset}); if (chunk.meta.sha256 !== meta.sha256 || chunk.offset !== offset) throw fail('素材版本在同步期间改变','ASSET_CHANGED',409); const data = Buffer.from(chunk.data,'base64'); if (!data.length || data.length > CHUNK || offset+data.length > meta.size) throw fail('素材分块无效'); await fsp.appendFile(filename,data); offset += data.length; this._emit('asset-progress',{id:meta.id,received:offset,total:meta.size}); }
          if (await fileHash(filename) !== meta.sha256) { await fsp.truncate(filename,0); throw fail('素材校验失败；未完成文件已重置，可安全重试','ASSET_HASH'); }
          await this._finishAsset(meta,filename);
        }
      } finally { this.syncing = false; this.assetSync = null; this._emit('assets-sync-finished'); }
    });
    return this.assetSync;
  }
  async _part(digest) { if (!/^[a-f0-9]{64}$/.test(digest)) throw fail('素材校验值无效'); const filename = path.join(this.dataDir,'transfers',digest+'.part'); await fsp.mkdir(path.dirname(filename),{recursive:true}); const handle = await fsp.open(filename,'a'); await handle.close(); return filename; }
  async _finishAsset(meta,filename) {
    const destination = path.join(this.dataDir,'shared-assets',meta.sha256); await fsp.mkdir(path.dirname(destination),{recursive:true});
    if (filename !== destination) { await fsp.copyFile(filename,destination); await fsp.unlink(filename); }
    let local; if (this.writeAsset) local = await this.writeAsset(clone(meta), meta.size <= 64*1024*1024 ? await fsp.readFile(destination) : null, {sourcePath:destination});
    this.assets.set(meta.id,{meta:clone(meta),filename:destination,local:scrub(local)}); await this._persist(); return meta;
  }
  async addAsset(meta,source) {
    await this.ready; if (!['hosting','joined'].includes(this.mode)) throw fail('尚未连接共享','OFFLINE');
    const existing = this.state.manifest.find(m => m.id === meta.id); if (existing && existing.owner !== this.identity.id) throw fail('不能覆盖他人的素材','OWNERSHIP',403);
    const clean = await this._storeAsset(meta,source,this.identity.id);
    if (this.mode === 'hosting') return this._serial(async () => { const existing = this.state.manifest.find(m => m.id === clean.id); if (existing && existing.owner !== this.identity.id) throw fail('不能覆盖他人的素材','OWNERSHIP',403); const next = clone(this.state); next.manifest = next.manifest.filter(m => m.id !== clean.id).concat(clean); next.snapshot.assets = clone(next.manifest); next.revision++; await this._commitState(next,'asset-added'); return clean; });
    const result = await this._request('asset.begin',{meta:clean}); const filename = this.assets.get(clean.id).filename, handle = await fsp.open(filename,'r'); let offset = result.offset;
    try { while (offset < clean.size) { const buffer = Buffer.alloc(Math.min(CHUNK,clean.size-offset)), {bytesRead} = await handle.read(buffer,0,buffer.length,offset); const chunk = await this._request('asset.chunk',{id:clean.id,sha256:clean.sha256,offset,data:buffer.subarray(0,bytesRead).toString('base64')}); offset = chunk.offset; } } finally { await handle.close(); }
    const committed = await this._request('asset.commit',{id:clean.id,sha256:clean.sha256}); this.state = committed.state; await this._apply('asset-added'); await this._persist(); return clean;
  }
  async _beginUpload({meta},owner) {
    const clean = assetMeta(meta,owner), existing = this.state.manifest.find(m => m.id === clean.id); if (existing && existing.owner !== owner) throw fail('不能覆盖他人的素材','OWNERSHIP',403);
    if (!this.uploads) this.uploads = new Map(); const filename = await this._part(clean.sha256), key = owner+':'+clean.id; this.uploads.set(key,{meta:clean,filename}); const size = (await fsp.stat(filename)).size; if (size > clean.size) await fsp.truncate(filename,0); return {offset:size > clean.size ? 0 : size};
  }
  async _writeChunk({id,sha256,offset,data},owner) {
    const upload = this.uploads?.get(owner+':'+id); if (!upload || upload.meta.sha256 !== sha256) throw fail('素材上传会话不存在');
    const current = (await fsp.stat(upload.filename)).size, bytes = Buffer.from(String(data),'base64'); if (offset !== current || bytes.length > CHUNK || current+bytes.length > upload.meta.size) throw fail('素材分块位置不匹配','ASSET_OFFSET',409); await fsp.appendFile(upload.filename,bytes); return {offset:current+bytes.length};
  }
  async _commitUpload({id,sha256},owner) {
    const upload = this.uploads?.get(owner+':'+id); if (!upload || upload.meta.sha256 !== sha256) throw fail('素材上传会话不存在');
    if ((await fsp.stat(upload.filename)).size !== upload.meta.size || await fileHash(upload.filename) !== sha256) throw fail('素材上传未完整通过校验','ASSET_HASH');
    // This runs inside the commit serial lock: a competing uploader may have claimed the id since begin.
    const existing=this.state.manifest.find(meta=>meta.id===id);if(existing&&existing.owner!==owner)throw fail('素材已由其他成员提交，不能覆盖其文件或引用','OWNERSHIP',403);
    await this._finishAsset(upload.meta,upload.filename); const next = clone(this.state); next.manifest = next.manifest.filter(m => m.id !== id).concat(upload.meta); next.snapshot.assets = clone(next.manifest); next.revision++; await this._commitState(next,'asset-added'); this.uploads.delete(owner+':'+id); return {state:clone(this.state)};
  }
  async changePassword(password = '') {
    await this.ready; if (this.mode !== 'hosting') throw fail('只有当前协调者可修改共享密码','NOT_HOST',403);
    if (typeof password === 'object') password = password.password || '';
    await this._serial(async () => { const next = clone(this.state); next.passwordRequired = !!password; next.revision++; await this._commitState(next,'password-changed'); this.authSalt = random(); this.passwordVerifier = password ? crypto.scryptSync(password,this.authSalt,32) : null; this.sessions.clear(); this.challenges.clear(); await this._persist(); }); this._emit('password-changed'); return this.status();
  }
  async stopSharing() {
    await this.ready; if (this.mode !== 'hosting') throw fail('只有当前协调者可结束本次共享','NOT_HOST',403);
    await this._serial(async () => { const next = clone(this.state); next.stopped = true; next.revision++; next.updatedAt = Date.now(); await this._commitState(next,'stopped'); this.mode = 'stopped'; await this._persist(); }); this._emit('stopped');
    // Keep a read-only tombstone endpoint until leave/dispose, so peers distinguish stop from outage.
    return this.status();
  }
  async leave() {
    await this.ready; this._stopPoll(); if (this.mode === 'joined') await this._request('member.leave').catch(() => {});
    await this._closeServer(); this.remote = null; this.mode = 'idle'; this.sessions.clear(); await this._persist(); this._emit('left'); return this.status();
  }
  async dispose() { this._stopPoll(); await this._closeServer(); this.sessions.clear(); this.mode = 'idle'; }
  async _vote(proposal,actor) {
    const members = this.state.members.filter(m => m.active), candidate = members.find(m => m.id === actor);
    if (!candidate || proposal.candidateId !== actor || proposal.sessionId !== this.state.sessionId || proposal.epoch !== this.state.epoch+1 || proposal.revision !== this.state.revision || proposal.digest !== hash(JSON.stringify(this.state.snapshot))) throw fail('接管基线不同或候选成员无效','ELECTION_CONFLICT',409);
    if (this.state.stopped) throw fail('主动停止的会话不能接管','STOPPED',410);
    if (this.prepared) throw fail('仍有已接收但未确认的共享写入，先重连恢复；不能用旧快照接管','UNCERTAIN_WRITE',409);
    if (this.vote?.epoch === proposal.epoch && this.vote.candidateId !== actor) throw fail('该协调周期已经投票给另一成员','ELECTION_CONFLICT',409);
    const oldHost = members.find(m => m.id === this.state.hostId);
    if (oldHost?.url) { try { const info = await requestJSON(oldHost.url,'/info',undefined,Math.min(this.timeoutMs,1500)); if (info.sessionId === this.state.sessionId && info.mode === 'hosting') throw fail('原协调者仍在线，不能接管','HOST_ALIVE',409); } catch (error) { if (error.code === 'HOST_ALIVE') throw error; } }
    this.vote = {...proposal, voterId:this.identity.id}; this._stopPoll(); await this._persist(); return {vote:this.vote,signature:signature(this.identity.privateKey,this.vote)};
  }
  async takeover({port = this.port || 47771, host = this.listenHost || '0.0.0.0', password = ''} = {}) {
    await this.ready; if (!this.state || this.state.stopped) throw fail('没有可接管的有效共享会话','STOPPED',410);
    if (this.mode === 'hosting') return this.status();
    const active = this.state.members.filter(m => m.active), proposal = {sessionId:this.state.sessionId, epoch:this.state.epoch+1, candidateId:this.identity.id, revision:this.state.revision, digest:hash(JSON.stringify(this.state.snapshot))};
    if (!active.some(m => m.id === this.identity.id)) throw fail('本机不是当前共享成员','MEMBER',403);
    const votes = [await this._vote(proposal,this.identity.id)], remotes = [];
    for (const member of active) {
      if (member.id === this.identity.id || member.id === this.state.hostId || !member.url) continue;
      try { const remote = await this._connect(member.url,'',member.id); remotes.push(remote); votes.push(await this._request('election.vote',proposal,remote)); } catch (error) { this._emit('election-peer-unavailable',{memberId:member.id,code:error.code || 'NETWORK'}); }
    }
    const required = Math.floor(active.length/2)+1;
    if (votes.length < required) throw fail(`接管需要 ${required} 位成员确认，目前只有 ${votes.length} 位。为防止双主，保留本地完整副本但不强制接管。`,'NO_QUORUM',409);
    await this._syncAssets().catch(error => { throw fail('素材尚未同步完整，不能接管：'+error.message,'ASSET_INCOMPLETE'); });
    await this._listen(port,host); const commit = {proposal,votes,url:this.url}; await this._commitElection(commit,this.identity.id);
    this.authSalt = random(); this.passwordVerifier = password ? crypto.scryptSync(password,this.authSalt,32) : null; this.state.passwordRequired = !!password; this.mode = 'hosting'; this.remote = null; this._stopPoll(); this.sessions.clear(); await this._persist();
    for (const remote of remotes) await this._request('election.commit',commit,remote,proposal.epoch-1).catch(() => {});
    this._emit('takeover'); return this.status();
  }
  async _commitElection({proposal,votes,url},actor) {
    if (actor !== proposal?.candidateId || proposal.epoch !== this.state.epoch+1 || proposal.sessionId !== this.state.sessionId) throw fail('接管提交无效','ELECTION_CONFLICT',409);
    const active = this.state.members.filter(m => m.active), valid = new Set();
    for (const item of votes || []) { const member = active.find(m => m.id === item.vote?.voterId); if (member && item.vote.candidateId === actor && item.vote.epoch === proposal.epoch && item.vote.sessionId === proposal.sessionId && item.vote.revision === proposal.revision && item.vote.digest === proposal.digest && verify(member.publicKey,item.vote,item.signature)) valid.add(member.id); }
    if (valid.size < Math.floor(active.length/2)+1 || proposal.digest !== hash(JSON.stringify(this.state.snapshot))) throw fail('接管缺少一致的多数成员签名','NO_QUORUM',409);
    await resolveLAN(url); this.state.epoch = proposal.epoch; this.state.hostId = actor; this.state.revision++; this.state.members.find(m => m.id === actor).url = url; this.vote = null; await this._persist();
    if (actor !== this.identity.id) { this.mode = 'disconnected'; this._stopPoll(); this.lastError = {code:'NEW_HOST',message:'已有成员接管，请使用新的共享地址和当前密码重新加入'}; this._emit('new-host',{url,hostId:actor}); }
    return true;
  }
}

module.exports = {CollaborationService, sharedSnapshot, scrub, privateIP};
