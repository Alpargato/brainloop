/**
 * Cifrado autenticado para el historial de chat: AES-256-CTR + HMAC-SHA256
 * (encrypt-then-MAC, claves independientes de 256 bits). TypeScript puro.
 *
 * Las dos claves se generan con el CSPRNG del sistema (expo-crypto) y se guardan
 * en expo-secure-store (Android Keystore). El texto cifrado va en AsyncStorage,
 * que no tiene el límite de 2048 bytes por valor de SecureStore.
 *
 * Verificado contra el vector de FIPS-197 y contra aes-256-ctr / HMAC de Node.js.
 */
import { hmacSha256, timingSafeEqualHex, toHex, utf8Decode, utf8Encode } from './pbkdf2';

// ---------- AES-256 (cifrado de bloque, tablas T) ----------

const SBOX = new Uint8Array(256);
const T0 = new Int32Array(256);
const T1 = new Int32Array(256);
const T2 = new Int32Array(256);
const T3 = new Int32Array(256);

(function initTables() {
  const rotl8 = (x: number, s: number) => ((x << s) | (x >>> (8 - s))) & 0xff;
  let p = 1;
  let q = 1;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    SBOX[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let x = 0; x < 256; x++) {
    const s = SBOX[x];
    const s2 = ((s << 1) ^ (s & 0x80 ? 0x1b : 0)) & 0xff;
    const s3 = s2 ^ s;
    const t = (s2 << 24) | (s << 16) | (s << 8) | s3;
    T0[x] = t;
    T1[x] = (t >>> 8) | (t << 24);
    T2[x] = (t >>> 16) | (t << 16);
    T3[x] = (t >>> 24) | (t << 8);
  }
})();

function expandKey256(key: Uint8Array): Int32Array {
  if (key.length !== 32) throw new Error('AES-256 requiere una clave de 32 bytes');
  const w = new Int32Array(60);
  for (let i = 0; i < 8; i++) {
    w[i] = (key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3];
  }
  let rcon = 1;
  for (let i = 8; i < 60; i++) {
    let t = w[i - 1];
    if (i % 8 === 0) {
      t = (t << 8) | (t >>> 24);
      t =
        ((SBOX[(t >>> 24) & 0xff] << 24) |
          (SBOX[(t >>> 16) & 0xff] << 16) |
          (SBOX[(t >>> 8) & 0xff] << 8) |
          SBOX[t & 0xff]) ^
        (rcon << 24);
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 0xff;
    } else if (i % 8 === 4) {
      t =
        (SBOX[(t >>> 24) & 0xff] << 24) |
        (SBOX[(t >>> 16) & 0xff] << 16) |
        (SBOX[(t >>> 8) & 0xff] << 8) |
        SBOX[t & 0xff];
    }
    w[i] = w[i - 8] ^ t;
  }
  return w;
}

function encryptBlock(w: Int32Array, input: Uint8Array, out: Uint8Array): void {
  let s0 = ((input[0] << 24) | (input[1] << 16) | (input[2] << 8) | input[3]) ^ w[0];
  let s1 = ((input[4] << 24) | (input[5] << 16) | (input[6] << 8) | input[7]) ^ w[1];
  let s2 = ((input[8] << 24) | (input[9] << 16) | (input[10] << 8) | input[11]) ^ w[2];
  let s3 = ((input[12] << 24) | (input[13] << 16) | (input[14] << 8) | input[15]) ^ w[3];
  let k = 4;
  for (let r = 1; r < 14; r++) {
    const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 0xff] ^ T2[(s2 >>> 8) & 0xff] ^ T3[s3 & 0xff] ^ w[k];
    const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 0xff] ^ T2[(s3 >>> 8) & 0xff] ^ T3[s0 & 0xff] ^ w[k + 1];
    const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 0xff] ^ T2[(s0 >>> 8) & 0xff] ^ T3[s1 & 0xff] ^ w[k + 2];
    const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 0xff] ^ T2[(s1 >>> 8) & 0xff] ^ T3[s2 & 0xff] ^ w[k + 3];
    s0 = t0;
    s1 = t1;
    s2 = t2;
    s3 = t3;
    k += 4;
  }
  const f = (a: number, b: number, c: number, d: number, rk: number) =>
    ((SBOX[a >>> 24] << 24) | (SBOX[(b >>> 16) & 0xff] << 16) | (SBOX[(c >>> 8) & 0xff] << 8) | SBOX[d & 0xff]) ^
    rk;
  const o = [f(s0, s1, s2, s3, w[56]), f(s1, s2, s3, s0, w[57]), f(s2, s3, s0, s1, w[58]), f(s3, s0, s1, s2, w[59])];
  for (let i = 0; i < 4; i++) {
    out[4 * i] = (o[i] >>> 24) & 0xff;
    out[4 * i + 1] = (o[i] >>> 16) & 0xff;
    out[4 * i + 2] = (o[i] >>> 8) & 0xff;
    out[4 * i + 3] = o[i] & 0xff;
  }
}

/** AES-256 de un único bloque de 16 bytes (expuesto para pruebas). */
export function aes256EncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  encryptBlock(expandKey256(key), block, out);
  return out;
}

/** AES-256-CTR (contador big-endian de 128 bits, igual que OpenSSL/Node). Cifra y descifra. */
export function aes256Ctr(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (iv.length !== 16) throw new Error('El IV debe tener 16 bytes');
  const w = expandKey256(key);
  const counter = new Uint8Array(iv);
  const ks = new Uint8Array(16);
  const out = new Uint8Array(data.length);
  for (let off = 0; off < data.length; off += 16) {
    encryptBlock(w, counter, ks);
    const n = Math.min(16, data.length - off);
    for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ ks[i];
    for (let i = 15; i >= 0; i--) {
      counter[i] = (counter[i] + 1) & 0xff;
      if (counter[i] !== 0) break;
    }
  }
  w.fill(0);
  return out;
}

// ---------- Base64 (sin depender de atob/btoa) ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_INV[B64.charCodeAt(i)] = i;

export function base64Encode(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    chunk +=
      B64[(n >>> 18) & 63] +
      B64[(n >>> 12) & 63] +
      (i + 1 < bytes.length ? B64[(n >>> 6) & 63] : '=') +
      (i + 2 < bytes.length ? B64[n & 63] : '=');
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

export function base64Decode(str: string): Uint8Array {
  const clean = str.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  const val = (i: number) => {
    const code = clean.charCodeAt(i);
    return code < 128 ? B64_INV[code] : -1;
  };
  if (clean.length % 4 === 1) throw new Error('Base64 inválido');
  for (let i = 0; i < clean.length; i += 4) {
    const a = val(i);
    const b = val(i + 1);
    const c = i + 2 < clean.length ? val(i + 2) : 0;
    const d = i + 3 < clean.length ? val(i + 3) : 0;
    if (!(a >= 0 && b >= 0 && c >= 0 && d >= 0)) throw new Error('Base64 inválido');
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (n >>> 16) & 0xff;
    if (i + 2 < clean.length) out[o++] = (n >>> 8) & 0xff;
    if (i + 3 < clean.length) out[o++] = n & 0xff;
  }
  return out.subarray(0, o);
}

// ---------- Sobre cifrado ----------

const VERSION = 'bl1';

function macInput(iv: Uint8Array, ct: Uint8Array): Uint8Array {
  const v = utf8Encode(VERSION);
  const buf = new Uint8Array(v.length + iv.length + ct.length);
  buf.set(v);
  buf.set(iv, v.length);
  buf.set(ct, v.length + iv.length);
  return buf;
}

/** Cifra y autentica `plaintext`. `iv` debe ser aleatorio (16 bytes) y no repetirse. */
export function sealString(plaintext: string, encKey: Uint8Array, macKey: Uint8Array, iv: Uint8Array): string {
  const ct = aes256Ctr(encKey, iv, utf8Encode(plaintext));
  const tag = hmacSha256(macKey, macInput(iv, ct));
  return `${VERSION}.${base64Encode(iv)}.${base64Encode(ct)}.${base64Encode(tag)}`;
}

/** Verifica la etiqueta (tiempo constante) y descifra. Devuelve null si algo no cuadra. */
export function openString(sealed: string, encKey: Uint8Array, macKey: Uint8Array): string | null {
  try {
    const [v, ivB64, ctB64, tagB64] = sealed.split('.');
    if (v !== VERSION || !ivB64 || ctB64 === undefined || !tagB64) return null;
    const iv = base64Decode(ivB64);
    const ct = base64Decode(ctB64);
    const expected = toHex(hmacSha256(macKey, macInput(iv, ct)));
    if (!timingSafeEqualHex(expected, toHex(base64Decode(tagB64)))) return null;
    return utf8Decode(aes256Ctr(encKey, iv, ct));
  } catch {
    return null;
  }
}
