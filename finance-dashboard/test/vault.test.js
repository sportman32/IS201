'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vault, WrongPassphraseError } = require('../lib/vault');

// Cheap scrypt settings so tests run fast; the app uses much stronger ones.
const fast = { scryptParams: { N: 2 ** 10, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')), 'vault.json');
const item = { itemId: 'item-1', accessToken: 'access-sandbox-secret-123', institutionName: 'Test Bank' };

test('round-trips items through an encrypted file', async () => {
  const file = tmpFile();
  const v = new Vault(file, fast);
  await v.create('correct horse battery');
  v.addItem(item);
  v.lock();

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('access-sandbox-secret-123'), 'token must not appear in plaintext');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

  const v2 = new Vault(file, fast);
  await v2.unlock('correct horse battery');
  assert.deepStrictEqual(v2.listItems(), [item]);
});

test('rejects the wrong passphrase', async () => {
  const file = tmpFile();
  const v = new Vault(file, fast);
  await v.create('correct horse battery');
  await assert.rejects(new Vault(file, fast).unlock('wrong passphrase!!'), WrongPassphraseError);
});

test('detects tampering', async () => {
  const file = tmpFile();
  const v = new Vault(file, fast);
  await v.create('correct horse battery');
  v.addItem(item);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bytes = Buffer.from(data.ciphertext, 'base64');
  bytes[0] ^= 1;
  data.ciphertext = bytes.toString('base64');
  fs.writeFileSync(file, JSON.stringify(data));
  await assert.rejects(new Vault(file, fast).unlock('correct horse battery'), WrongPassphraseError);
});

test('rejects weak passphrases and refuses access when locked', async () => {
  const v = new Vault(tmpFile(), fast);
  await assert.rejects(v.create('fifteen chars!!'), /at least 16/);
  await assert.rejects(v.create('abababababababababab'), /repetitive/);
  assert.throws(() => v.listItems(), /locked/);
  assert.throws(() => v.getPlaidConfig(), /locked/);
});

test('stores Plaid keys encrypted', async () => {
  const file = tmpFile();
  const v = new Vault(file, fast);
  await v.create('correct horse battery');
  assert.strictEqual(v.getPlaidConfig(), null);
  v.setPlaidConfig({ env: 'sandbox', clientId: 'client123456', secret: 'supersecretvalue123' });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('supersecretvalue123'), 'secret must not appear in plaintext');
  v.lock();
  const v2 = new Vault(file, fast);
  await v2.unlock('correct horse battery');
  assert.strictEqual(v2.getPlaidConfig().secret, 'supersecretvalue123');
});

test('updates and removes items', async () => {
  const v = new Vault(tmpFile(), fast);
  await v.create('correct horse battery');
  v.addItem(item);
  v.addItem({ ...item, institutionName: 'Renamed' });
  assert.strictEqual(v.listItems().length, 1);
  assert.strictEqual(v.listItems()[0].institutionName, 'Renamed');
  v.removeItem('item-1');
  assert.deepStrictEqual(v.listItems(), []);
  v.addItem(item);
  v.clearItems();
  assert.deepStrictEqual(v.listItems(), []);
});
