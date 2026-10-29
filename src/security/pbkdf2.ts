/**
 * PBKDF2-HMAC-SHA256 en TypeScript puro (sin módulos nativos).
 *
 * Se usa para derivar el hash de la contraseña local. Implementación optimizada:
 * los estados HMAC (ipad/opad) se precalculan una sola vez, así cada iteración
 * cuesta exactamente 2 compresiones SHA-256.
 *
 * Verificado contra los vectores de prueba de RFC 7914 §11 y contra
 * crypto.pbkdf2Sync de Node.js con entradas aleatorias.
 */

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV = new Int32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** Comprime un bloque de 64 bytes (16 palabras big-endian en W[0..15]) sobre el estado H. */
function compress(H: Int32Array, W: Int32Array): void {
  for (let i = 16; i < 64; i++) {
    const w15 = W[i - 15];
    const w2 = W[i - 2];
    const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
    const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = H[0];
  let b = H[1];
  let c = H[2];
  let d = H[3];
  let e = H[4];
  let f = H[5];
  let g = H[6];
  let h = H[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0;
  H[1] = (H[1] + b) | 0;
  H[2] = (H[2] + c) | 0;
  H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0;
  H[5] = (H[5] + f) | 0;
  H[6] = (H[6] + g) | 0;
  H[7] = (H[7] + h) | 0;
}

/**
 * Hashea `msg` partiendo del estado `state`, que ya ha consumido `prefixBytes` bytes
 * (múltiplo de 64). Devuelve el estado final (8 palabras = digest).
 */
function hashFrom(state: Int32Array, prefixBytes: number, msg: Uint8Array): Int32Array {
  const H = new Int32Array(state);
  const W = new Int32Array(64);
  const total = prefixBytes + msg.length;
  const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const bitLenHi = Math.floor((total * 8) / 0x100000000);
  const bitLenLo = (total * 8) >>> 0;
  const n = padded.length;
  padded[n - 8] = (bitLenHi >>> 24) & 0xff;
  padded[n - 7] = (bitLenHi >>> 16) & 0xff;
  padded[n - 6] = (bitLenHi >>> 8) & 0xff;
  padded[n - 5] = bitLenHi & 0xff;
  padded[n - 4] = (bitLenLo >>> 24) & 0xff;
  padded[n - 3] = (bitLenLo >>> 16) & 0xff;
  padded[n - 2] = (bitLenLo >>> 8) & 0xff;
  padded[n - 1] = bitLenLo & 0xff;
  for (let off = 0; off < n; off += 64) {
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4;
      W[j] = (padded[p] << 24) | (padded[p + 1] << 16) | (padded[p + 2] << 8) | padded[p + 3];
    }
    compress(H, W);
  }
  return H;
}

function wordsToBytes(words: Int32Array, out: Uint8Array, offset: number, len: number): void {
  for (let i = 0; i < len; i++) {
    out[offset + i] = (words[i >> 2] >>> (24 - (i & 3) * 8)) & 0xff;
  }
}

/** SHA-256 de un array de bytes. */
export function sha256(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  wordsToBytes(hashFrom(IV, 0, data), out, 0, 32);
  return out;
}

/** HMAC-SHA256 (RFC 2104). */
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256(key) : key);
  const ipad = new Uint8Array(64 + data.length);
  const opad = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    ipad[i] = k[i] ^ 0x36;
    opad[i] = k[i] ^ 0x5c;
  }
  ipad.set(data, 64);
  opad.set(sha256(ipad), 64);
  k.fill(0);
  return sha256(opad);
}

/** PBKDF2-HMAC-SHA256 (RFC 8018). */
export function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  dkLen = 32
): Uint8Array {
  if (iterations < 1 || dkLen < 1) throw new Error('Parámetros PBKDF2 inválidos');
  // Clave HMAC normalizada a 64 bytes
  const key = new Uint8Array(64);
  key.set(password.length > 64 ? sha256(password) : password);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    ipad[i] = key[i] ^ 0x36;
    opad[i] = key[i] ^ 0x5c;
  }
  const W = new Int32Array(64);
  const loadBlock = (bytes: Uint8Array) => {
    for (let j = 0; j < 16; j++) {
      const p = j * 4;
      W[j] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    }
  };
  const iState = new Int32Array(IV);
  loadBlock(ipad);
  compress(iState, W);
  const oState = new Int32Array(IV);
  loadBlock(opad);
  compress(oState, W);

  const out = new Uint8Array(dkLen);
  const blocks = Math.ceil(dkLen / 32);
  const msg = new Uint8Array(salt.length + 4);
  msg.set(salt);
  const inner = new Int32Array(8);
  const outer = new Int32Array(8);
  const T = new Int32Array(8);

  for (let blk = 1; blk <= blocks; blk++) {
    msg[salt.length] = (blk >>> 24) & 0xff;
    msg[salt.length + 1] = (blk >>> 16) & 0xff;
    msg[salt.length + 2] = (blk >>> 8) & 0xff;
    msg[salt.length + 3] = blk & 0xff;
    // U1 = HMAC(P, S || INT(blk))
    const ih = hashFrom(iState, 64, msg);
    const u1Bytes = new Uint8Array(32);
    wordsToBytes(ih, u1Bytes, 0, 32);
    const U = hashFrom(oState, 64, u1Bytes);
    T.set(U);
    // U2..Uc: mensajes de 32 bytes -> un único bloque con padding fijo (768 bits)
    for (let it = 1; it < iterations; it++) {
      inner.set(iState);
      for (let j = 0; j < 8; j++) W[j] = U[j];
      W[8] = 0x80000000;
      W[9] = 0; W[10] = 0; W[11] = 0; W[12] = 0; W[13] = 0; W[14] = 0;
      W[15] = 768;
      compress(inner, W);
      outer.set(oState);
      for (let j = 0; j < 8; j++) W[j] = inner[j];
      W[8] = 0x80000000;
      W[9] = 0; W[10] = 0; W[11] = 0; W[12] = 0; W[13] = 0; W[14] = 0;
      W[15] = 768;
      compress(outer, W);
      for (let j = 0; j < 8; j++) {
        U[j] = outer[j];
        T[j] ^= outer[j];
      }
    }
    const take = Math.min(32, dkLen - (blk - 1) * 32);
    wordsToBytes(T, out, (blk - 1) * 32, take);
  }
  key.fill(0);
  ipad.fill(0);
  opad.fill(0);
  return out;
}

/** Codifica un string JS como UTF-8 (sin depender de TextEncoder). */
export function utf8Encode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
  }
  return Uint8Array.from(bytes);
}

/** Decodifica UTF-8 a string JS (sin depender de TextDecoder). */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    let cp: number;
    if (b0 < 0x80) cp = b0;
    else if (b0 < 0xe0) cp = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b0 < 0xf0) cp = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else
      cp =
        ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Comparación en tiempo constante de dos strings hex de igual longitud. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
