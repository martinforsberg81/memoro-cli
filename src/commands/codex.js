import { spawn } from 'node:child_process';
import { pullLens } from './lens.js';
import { uploadSession } from './session.js';
import {
  findLatestCodexSession,
  guessRepoHint,
  resolveWorkspaceRoot,
  resolveRealCodexBinary,
} from '../lib/codex.js';

export async function runCodex(argv) {
  const { flags, passthrough } = parseFlags(argv);
  const workspace = resolveWorkspaceRoot(process.cwd());
  const repoHint = flags.repo || guessRepoHint(workspace);
  const codexBinary = flags.realCodex || resolveRealCodexBinary();

  if (!codexBinary) {
    console.error('[memoro-cli] Could not locate the real Codex binary.');
    return 1;
  }

  if (!flags.noLens) {
    const lensArgs = ['--tool', 'codex'];
    if (repoHint) lensArgs.push('--repo', repoHint);
    try {
      await pullLens(lensArgs);
    } catch (err) {
      console.error(`[memoro-cli] Lens pull failed: ${err.message}`);
    }
  }

  const before = await findLatestCodexSession({ cwd: workspace });
  const codexExit = await runChild(codexBinary, passthrough);

  if (!flags.noUpload) {
    const latest = await findLatestCodexSession({
      cwd: workspace,
      newerThanMs: before?.mtimeMs ? before.mtimeMs + 1 : 0,
    });
    if (latest?.path) {
      const uploadArgs = [latest.path, '--tool', 'codex', '--yes'];
      if (repoHint) uploadArgs.push('--repo', repoHint);
      if (latest.toolVersion) uploadArgs.push('--tool-version', latest.toolVersion);
      try {
        await uploadSession(uploadArgs);
      } catch (err) {
        console.error(`[memoro-cli] Codex session upload failed: ${err.message}`);
      }
    } else {
      console.error('[memoro-cli] No new Codex session file found to upload.');
    }
  }

  return codexExit;
}

function parseFlags(argv) {
  const flags = {
    repo: null,
    realCodex: null,
    noLens: false,
    noUpload: false,
  };
  const passthrough = [];
  let afterSeparator = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (afterSeparator) {
      passthrough.push(a);
      continue;
    }
    if (a === '--') {
      afterSeparator = true;
      continue;
    }
    if (a === '--repo' && argv[i + 1]) { flags.repo = argv[++i]; continue; }
    if (a === '--real-codex' && argv[i + 1]) { flags.realCodex = argv[++i]; continue; }
    if (a === '--no-lens') { flags.noLens = true; continue; }
    if (a === '--no-upload') { flags.noUpload = true; continue; }
    passthrough.push(a);
  }

  return { flags, passthrough };
}

function runChild(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) resolve(1);
      else resolve(code ?? 0);
    });
  });
}
