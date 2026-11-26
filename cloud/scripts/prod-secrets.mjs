// Kiwimake Cloud's production secrets that Kiwimake makes itself (docs/CLOUD.md section 11), into
// ~/.appwin-secrets/cloud-prod.env (mode 600), never printed. Made once: a value already in the
// file is kept, because changing KEYS_KEK would make every sealed signing key unreadable and
// changing the sign-in key would sign everybody out.
//   node scripts/prod-secrets.mjs            add the missing ones, print only their names
// The file is then saved to 1Password ("Kiwimake Cloud (prod) secrets") by the caller.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROD_FILE = path.join(process.env.ANYAPP_CLOUD_SECRETS ?? path.join(os.homedir(), '.appwin-secrets'), 'cloud-prod.env');

export function readProd(file = PROD_FILE) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Adds or replaces one line; the file stays mode 600. Values are one line (no newlines). */
export function writeProd(name, value, file = PROD_FILE) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`bad name ${name}`);
  if (/[\r\n]/.test(value)) throw new Error(`${name}: one line only`);
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith(`${name}=`)) : [];
  lines.push(`${name}=${value}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

async function made() {
  const out = {};
  // The master key for signing keys and secrets (version 1, until Cloud KMS): 32 random bytes.
  out.KEYS_KEK = crypto.randomBytes(32).toString('base64');
  // The key transport (P-256): the desktop seals a signing key to the public half.
  const pair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  out.KEYS_TRANSPORT_PRIVATE = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  out.KEYS_TRANSPORT_PUBLIC = Buffer.from(await crypto.webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64');
  // Convex Auth's session signing key, in the form its own generator writes (RS256).
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  out.JWT_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trimEnd().replace(/\n/g, ' ');
  out.JWKS = JSON.stringify({ keys: [{ use: 'sig', ...publicKey.export({ format: 'jwk' }) }] });
  return out;
}

if (process.argv[1]?.endsWith('prod-secrets.mjs')) {
  const have = readProd();
  const fresh = await made();
  // The transport pair and the sign-in pair are made together or not at all.
  const groups = [['KEYS_KEK'], ['KEYS_TRANSPORT_PRIVATE', 'KEYS_TRANSPORT_PUBLIC'], ['JWT_PRIVATE_KEY', 'JWKS']];
  for (const g of groups) {
    if (g.every((n) => have[n])) continue;
    if (g.some((n) => have[n])) throw new Error(`${g.join(' and ')}: only some are in the file; fix it by hand`);
    for (const n of g) writeProd(n, fresh[n]);
    console.log(`made ${g.join(', ')}`);
  }
}
