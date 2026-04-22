/**
 * memoro-cli login / logout / status
 */

import { setSecret, getSecret, deleteSecret } from '../lib/keychain.js';
import { readConfig, getApiUrl } from '../lib/config.js';
import { promptSecret } from '../lib/prompt.js';
import { memoroFetch } from '../lib/api.js';

const TOKEN_ACCOUNT = 'memoro-api-token';
const ANTHROPIC_ACCOUNT = 'anthropic-api-key';

export async function login(argv) {
  const existing = await getSecret(TOKEN_ACCOUNT);
  if (existing) {
    console.log('A Memoro token is already stored. Run `memoro-cli logout` to remove it first.');
    return 1;
  }

  // Token sources, in priority order:
  //   --token <value>  (convenient, but leaks to shell history)
  //   MEMORO_TOKEN env (good for scripts)
  //   piped stdin       (`echo mem_... | memoro-cli login` — no history risk)
  //   interactive       (hidden prompt)
  const tokenIdx = argv.indexOf('--token');
  let token = null;
  if (tokenIdx !== -1 && argv[tokenIdx + 1]) {
    token = argv[tokenIdx + 1].trim();
  } else if (process.env.MEMORO_TOKEN) {
    token = process.env.MEMORO_TOKEN.trim();
  } else {
    console.log('Create a token at https://meetmemoro.app/app/settings → API tokens (Full access recommended).');
    console.log('Tip: if paste into the hidden prompt misbehaves, run: echo "mem_..." | memoro-cli login');
    token = (await promptSecret('Memoro API token: ')).trim();
  }

  if (!token || !token.startsWith('mem_') || token.length < 20) {
    console.error('Invalid token format — must start with "mem_" and be the full token copied from settings.');
    return 1;
  }
  const stored = await setSecret(TOKEN_ACCOUNT, token);
  console.log(`✓ Token saved (${stored === 'keychain' ? 'OS keychain' : 'file fallback'}).`);
  return 0;
}

export async function logout(_argv) {
  const existed = await getSecret(TOKEN_ACCOUNT);
  if (!existed) {
    console.log('No token to remove.');
    return 0;
  }
  await deleteSecret(TOKEN_ACCOUNT);
  console.log('✓ Token removed.');
  return 0;
}

export async function status(argv) {
  const config = await readConfig();
  const apiUrl = getApiUrl(argv) || config.apiUrl;
  const token = await getSecret(TOKEN_ACCOUNT);
  const anthropic = await getSecret(ANTHROPIC_ACCOUNT);

  console.log(`Memoro API:            ${apiUrl}`);
  console.log(`Memoro token:          ${token ? '✓ stored' : '✗ not logged in'}`);
  console.log(`Anthropic key:         ${anthropic ? '✓ stored' : '✗ not set (run: memoro-cli config set anthropic-api-key ...)'}`);
  console.log(`Last session upload:   ${config.lastSessionUploadAt || 'never'}`);
  console.log(`Last lens pull:        ${config.lastLensPullAt || 'never'}`);

  const hooks = config.installedHooks || {};
  const toolCount = Object.keys(hooks).length;
  console.log(`Hooks installed:       ${toolCount === 0 ? 'none' : Object.keys(hooks).join(', ')}`);

  if (token) {
    try {
      // Quick sanity-check: GET /api/boot or similar. We'll use the lens
      // endpoint with an obviously-wrong repo so it returns quickly.
      await memoroFetch(apiUrl, '/api/lens/portrait-coding', { token });
      console.log('Connection:            ✓ ok');
    } catch (err) {
      console.log(`Connection:            ✗ ${err.message}`);
    }
  }
  return 0;
}

// Exposed for other commands
export const ACCOUNTS = {
  TOKEN: TOKEN_ACCOUNT,
  ANTHROPIC: ANTHROPIC_ACCOUNT,
};
