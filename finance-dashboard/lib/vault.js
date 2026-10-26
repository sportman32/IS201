'use strict';

// Encrypted on-disk store for Plaid access tokens.
//
// The file is encrypted with AES-256-GCM using a key derived from your
// passphrase with scrypt. The passphrase and key are never written to disk,
// so the file is useless to anyone who copies it without the passphrase.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMAT_VERSION = 1;
// scrypt cost: N=2^17 takes roughly 0.3-1s per guess, making brute force slow.
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_LEN = 32;
const MIN_PASSPHRASE_LEN = 16;
const MIN_DISTINCT_CHARS = 8;

class WrongPassphraseError extends Error {}

// Returns an error message, or null if the passphrase is acceptable.
function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LEN) {
    return `Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters.`;
  }
  if (new Set(passphrase).size < MIN_DISTINCT_CHARS) {
    return 'Passphrase is too repetitive. Try several random words.';
  }
  return null;
}

function deriveKey(passphrase, salt, params = SCRYPT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, KEY_LEN, params, (err, key) =>
      err ? reject(err) : resolve(key));
  });
}

function encrypt(key, data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function decrypt(key, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  try {
    const plaintext = Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    // GCM authentication fails for a wrong key or a tampered file.
    throw new WrongPassphraseError('Wrong passphrase, or the vault file was modified.');
  }
}

class Vault {
  constructor(filePath, { scryptParams = SCRYPT } = {}) {
    this.filePath = filePath;
    this.scryptParams = scryptParams;
    this.key = null;
    this.salt = null;
    this.data = null;
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  isUnlocked() {
    return this.key !== null;
  }

  async create(passphrase) {
    if (this.exists()) throw new Error('Vault already exists.');
    const problem = checkPassphrase(passphrase);
    if (problem) throw new Error(problem);
    this.salt = crypto.randomBytes(16);
    this.key = await deriveKey(passphrase, this.salt, this.scryptParams);
    this.data = { plaid: null, items: [] };
    this.save();
  }

  async unlock(passphrase) {
    const file = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (file.version !== FORMAT_VERSION) throw new Error('Unsupported vault version.');
    const salt = Buffer.from(file.salt, 'base64');
    const key = await deriveKey(String(passphrase), salt, file.scrypt);
    this.data = decrypt(key, file);
    this.salt = salt;
    this.key = key;
  }

  lock() {
    if (this.key) this.key.fill(0);
    this.key = null;
    this.salt = null;
    this.data = null;
  }

  save() {
    if (!this.isUnlocked()) throw new Error('Vault is locked.');
    const file = {
      version: FORMAT_VERSION,
      salt: this.salt.toString('base64'),
      scrypt: { N: this.scryptParams.N, r: this.scryptParams.r, p: this.scryptParams.p, maxmem: this.scryptParams.maxmem },
      ...encrypt(this.key, this.data),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    // Write to a temp file then rename, so a crash never leaves a half-written vault.
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  // Plaid API keys ({ env, clientId, secret }) live inside the encrypted vault, never in plain files.
  getPlaidConfig() {
    if (!this.isUnlocked()) throw new Error('Vault is locked.');
    return this.data.plaid || null;
  }

  setPlaidConfig(config) {
    if (!this.isUnlocked()) throw new Error('Vault is locked.');
    this.data.plaid = config;
    this.save();
  }

  listItems() {
    if (!this.isUnlocked()) throw new Error('Vault is locked.');
    return this.data.items;
  }

  addItem(item) {
    const items = this.listItems();
    const existing = items.findIndex((i) => i.itemId === item.itemId);
    if (existing >= 0) items[existing] = item;
    else items.push(item);
    this.save();
  }

  removeItem(itemId) {
    this.data.items = this.listItems().filter((i) => i.itemId !== itemId);
    this.save();
  }

  clearItems() {
    this.listItems();
    this.data.items = [];
    this.save();
  }
}

module.exports = { Vault, WrongPassphraseError, checkPassphrase, MIN_PASSPHRASE_LEN };
