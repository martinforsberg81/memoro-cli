/**
 * memoro-cli config set / get
 *
 * Non-secret config keys live in ~/.memoro/config.json.
 */

import { readConfig, updateConfig } from '../lib/config.js';

const CONFIG_KEYS = new Set([
  'api-url',
]);

export async function configSet(argv) {
  const [key, ...valueParts] = argv.filter(a => !a.startsWith('--'));
  const value = valueParts.join(' ').trim();

  if (!key || !value) {
    console.error('Usage: memoro-cli config set <key> <value>');
    console.error(`Known keys: ${[...CONFIG_KEYS].join(', ')}`);
    return 2;
  }

  if (CONFIG_KEYS.has(key)) {
    await updateConfig({ [camelize(key)]: value });
    console.log(`✓ ${key} saved.`);
    return 0;
  }

  console.error(`Unknown config key: ${key}`);
  console.error(`Known keys: ${[...CONFIG_KEYS].join(', ')}`);
  return 2;
}

export async function configGet(argv) {
  const key = argv.find(a => !a.startsWith('--'));
  if (!key) {
    console.error('Usage: memoro-cli config get <key>');
    return 2;
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

function camelize(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
