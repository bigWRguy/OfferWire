// Repo-as-database. Plain JSON/NDJSON so git gives us a free, diffable audit log.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

export const ROOT = path.resolve(url.fileURLToPath(new URL('../../', import.meta.url)));
export const DATA = path.join(ROOT, 'data');
export const CONFIG = path.join(ROOT, 'config');

const ensure = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };

export function readJson(rel, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8')); } catch { return fallback; }
}
export function writeJson(rel, obj) {
  fs.writeFileSync(ensure(path.join(DATA, rel)), JSON.stringify(obj, null, 2) + '\n');
}
export function appendNdjson(rel, rows) {
  if (!rows.length) return;
  fs.appendFileSync(ensure(path.join(DATA, rel)), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
export function readNdjson(rel) {
  const p = path.join(DATA, rel);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// Bounded cache so we never pay the LLM twice for the same text.
export class Cache {
  constructor(rel, max = 40000) { this.rel = rel; this.max = max; this.map = readJson(rel, {}); }
  get(k) { const v = this.map[k]; if (v) v.t = Date.now(); return v?.v; }
  set(k, v) { this.map[k] = { v, t: Date.now() }; }
  flush() {
    const keys = Object.keys(this.map);
    if (keys.length > this.max) {
      keys.sort((a, b) => this.map[a].t - this.map[b].t)
        .slice(0, keys.length - this.max).forEach((k) => delete this.map[k]);
    }
    writeJson(this.rel, this.map);
  }
}
