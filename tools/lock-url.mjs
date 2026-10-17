// Encrypts the Power Automate flow URL with the team code and writes it into config.js.
// Usage (values via environment so they never land in shell history files or the repo):
//   FLOW_URL="https://..." TEAM_CODE="..." node tools/lock-url.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const url = (process.env.FLOW_URL || '').trim();
const code = (process.env.TEAM_CODE || '').trim();
if (!/^https:\/\//.test(url) || !code) { console.error('Set FLOW_URL and TEAM_CODE'); process.exit(1); }

const iter = 310000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
  base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(url)));
const b64 = a => Buffer.from(a).toString('base64');
const enc = JSON.stringify({ iter, salt: b64(salt), iv: b64(iv), data: b64(data) });

const path = new URL('../config.js', import.meta.url);
const src = readFileSync(path, 'utf8');
const out = src.replace(/FLOW_ENC: .*,/, `FLOW_ENC: ${enc},`);
if (out === src) { console.error('FLOW_ENC line not found in config.js'); process.exit(1); }
writeFileSync(path, out);
console.log('config.js updated (encrypted URL, ' + data.length + ' bytes)');
