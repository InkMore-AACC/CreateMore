'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const fss = require('node:fs');

class ProviderError extends Error {
  constructor(message, code = 'PROVIDER_ERROR', details = {}) { super(message); this.name = 'ProviderError'; this.code = code; this.uncertain = ['STATUS_UNKNOWN','ABORTED','CANCELLED','CODEX_DISCONNECTED'].includes(code); this.details = redact(details); }
}
function redact(value) {
  if (typeof value === 'string') return value.replace(/Bearer\s+[\w.+/=-]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[\w-]+/g, '[REDACTED]').replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(api.?key|token|authorization|password|secret|access.?token|refresh.?token)$/i.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
}
function endpoint(value, fallback) { const u = new URL(value || fallback); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new ProviderError('连接地址必须是无内嵌凭据的 HTTP/HTTPS 地址', 'INVALID_ENDPOINT'); return u.href.replace(/\/$/, ''); }
async function jsonFetch(fetcher, url, options = {}, timeoutMs = 15000) {
  let response;
  try { response = await fetcher(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }); }
  catch (e) { if(options.signal?.aborted)throw new ProviderError('本机等待已取消；远端状态需要核对','ABORTED');throw new ProviderError(`无法连接服务：${redact(e.message)}`,options.method==='POST'?'STATUS_UNKNOWN':'NETWORK_ERROR'); }
  const raw = await response.text();
  let data; try { data = raw ? JSON.parse(raw) : {}; } catch { throw new ProviderError('服务返回的不是 JSON', 'INVALID_RESPONSE', { status: response.status, body: raw.slice(0, 1000) }); }
  if (!response.ok) throw new ProviderError(`服务请求失败（${response.status}）`, 'HTTP_ERROR', { status: response.status, response: data });
  return data;
}
function post(body) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
function abortCheck(signal) { if (signal?.aborted) throw new ProviderError('已取消本次等待；远端任务需核对', 'ABORTED'); }
function sleep(ms, signal) { return new Promise((resolve, reject) => { abortCheck(signal); const timer = setTimeout(done, ms); function done() { signal?.removeEventListener('abort', aborted); resolve(); } function aborted() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(new ProviderError('已取消本次等待；远端任务需核对', 'ABORTED')); } signal?.addEventListener('abort', aborted, { once: true }); }); }
function safeName(value) { return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 140) || 'output'; }
async function writeAtomic(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${crypto.randomUUID()}.partial`; try { await fs.writeFile(tmp, value); await fs.rename(tmp, file); } catch (e) { await fs.rm(tmp, { force: true }).catch(() => {}); throw e; } }
async function saveText(outputDir, text, prefix = 'text') { const file = path.join(outputDir, `${safeName(prefix)}-${crypto.randomUUID()}.txt`); await writeAtomic(file, text); return { path: file, type: 'text', mime: 'text/plain' }; }
async function download(fetcher, url, outputDir, name, options = {}) {
  await fs.mkdir(outputDir, { recursive: true }); const file = path.join(outputDir, `${crypto.randomUUID()}-${safeName(name)}`); const tmp = `${file}.partial`;
  const response = await fetcher(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new ProviderError(`结果下载失败（${response.status}）`, 'DOWNLOAD_FAILED');
  try { await pipeline(Readable.fromWeb(response.body), fss.createWriteStream(tmp, { flags: 'wx' })); const stat = await fs.stat(tmp); if (!stat.size) throw new ProviderError('生成结果为空文件', 'EMPTY_OUTPUT'); await fs.rename(tmp, file); return { path: file, bytes: stat.size, mime: response.headers.get('content-type') }; }
  catch (e) { await fs.rm(tmp, { force: true }).catch(() => {}); throw e; }
}
function mediaType(filename, fallback = 'file') { const ext = path.extname(filename).toLowerCase(); if (['.png','.jpg','.jpeg','.webp','.gif','.bmp','.tif'].includes(ext)) return 'image'; if (['.mp4','.webm','.mov','.mkv','.avi'].includes(ext)) return 'video'; if (['.wav','.mp3','.flac','.ogg','.m4a','.aac'].includes(ext)) return 'audio'; if (['.txt','.json','.csv','.md'].includes(ext)) return 'text'; return fallback; }
module.exports = { ProviderError, redact, endpoint, jsonFetch, post, abortCheck, sleep, safeName, writeAtomic, saveText, download, mediaType };
