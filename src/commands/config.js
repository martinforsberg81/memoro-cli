/**
 * memoro-cli config set / get
 *
 * Non-secret config keys live in ~/.memoro/config.json. Secret keys
 * (anthropic-api-key) are routed to the OS keychain via keychain.js.
 */

import { readConfig, updateConfig } from '../lib/config.js';
import { setSecret, getSecret } from '../lib/keychain.js';
import { ACCOUNTS } from './auth.js';

const SECRET_KEYS = new Set([
  'anthropic-api-key',
]);

const CONFIG_KEYS = new Set([
  'api-url',
]);

export async function configSet(argv) {
  const [key, ...valueParts] = argv.filter(a => !a.startsWith('--'));
  const value = valueParts.join(' ').trim();

  if (!key || !value) {
    console.error('Usage: memoro-cli config set <key> <value>');
    console.error(`Known keys: ${[...SECRET_KEYS, ...CONFIG_KEYS].join(', ')}`);
    return 2;
  }

  if (SECRET_KEYS.has(key)) {
    const account = mapSecretKey(key);
    const where = await setSecret(account, value);
    console.log(`✓ ${key} saved (${where === 'keychain' ? 'OS keychain' : 'file fallback'}).`);
    return 0;
  }

  if (CONFIG_KEYS.has(key)) {
    await updateConfig({ [camelize(key)]: value });
    console.log(`✓ ${key} saved.`);
    return 0;
  }

  console.error(`Unknown config key: ${key}`);
  console.error(`Known keys: ${[...SECRET_KEYS, ...CONFIG_KEYS].join(', ')}`);
  return 2;
}

export async function configGet(argv) {
  const key = argv.find(a => !a.startsWith('--'));
  if (!key) {
    console.error('Usage: memoro-cli config get <key>');
    return 2;
  }

  if (SECRET_KEYS.has(key)) {
    const account = mapSecretKey(key);
    const stored = await getSecret(account);
    if (!stored) {
      console.log(`(not set)`);
      return 0;
    }
    // Don't print the secret — only indicate presence + a prefix preview.
    console.log(`✓ stored (${stored.slice(0, 8)}…)`);
    return 0;
  }

  if (CONFIG_KEYS.has(key)) {
    const config = await readConfig();
    const v = config[camelize(key)];
    console.log(v ?? '(not set)');
    return 0;
  }

  console.error(`Unknown config key: ${key}`);
  return 2;
}

function mapSecretKey(key) {
  if (key === 'anthropic-api-key') return ACCOUNTS.ANTHROPIC;
  throw new Error(`No keychain mapping for ${key}`);
}

function camelize(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
