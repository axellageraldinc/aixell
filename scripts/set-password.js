// Setup: password + TOTP secret + recovery codes. Interactive, or --password-stdin for scripts.
// Options: --user NAME (default admin), --file PATH (auth record), --password-stdin.
// Files go to $HERMES_WEB_DATA_DIR (default <repo>/data).
// The password never enters argv, shell history, or a file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
const username = args.includes('--user') ? value('--user') : 'admin';
const dataDir = process.env.HERMES_WEB_DATA_DIR || path.join(dir, '..', 'data');
const file = args.includes('--file') ? value('--file') : path.join(dataDir, 'auth-record.json');
const recoveryFile = path.join(path.dirname(file), 'recovery-codes.json');
const fromStdin = args.includes('--password-stdin');

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text.replace(/\r?\n$/, '');
}

// Reads one line without echo by switching the TTY to raw mode (no stty, no child process).
function secret(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    let text = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { done(); return reject(new Error('Cancelled.')); }
        if (ch === '\r' || ch === '\n') { done(); return resolve(text); }
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else text += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function randomBase32(bytesLen = 20) {
  const bytes = crypto.randomBytes(bytesLen);
  let bits = 0, value_ = 0, out = '';
  for (const byte of bytes) {
    value_ = (value_ << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value_ >> bits) & 31];
    }
  }
  return out;
}

function randomRecoveryCode() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

try {
  let password;
  if (fromStdin) {
    password = await readStdin();
  } else {
    if (!process.stdin.isTTY) throw new Error('Run this command in a terminal, or pipe the password with --password-stdin.');
    password = await secret('New aixell password: ');
    const again = await secret('Repeat password: ');
    if (password !== again) throw new Error('Passwords do not match.');
  }
  if (!password) throw new Error('The password is empty.');

  const record = await hashPassword(username, password);
  record.totpSecret = randomBase32();

  const recoveryCodes = Array.from({ length: 5 }, () => randomRecoveryCode());
  record.recoveryHashes = recoveryCodes.map((code) =>
    crypto.createHash('sha256').update(code).digest('hex')
  );

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(recoveryFile), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(recoveryFile, JSON.stringify({ used: [] }), { mode: 0o600 });

  console.log('\nSaved.', file);
  console.log('Username:', username);
  console.log('\nTOTP setup key (enter manually into your authenticator app):');
  console.log('  ', record.totpSecret.match(/.{1,4}/g).join(' '));
  console.log('\nOr the otpauth URI (for apps that can import it):');
  console.log('  ', `otpauth://totp/aixell:${encodeURIComponent(username)}?secret=${record.totpSecret}&issuer=aixell`);
  console.log('\nOne-time recovery codes (store these somewhere safe, each works once):');
  for (const code of recoveryCodes) console.log('  ', code);
  console.log('\nIf the server is already running, restart it so it reads the new record.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
