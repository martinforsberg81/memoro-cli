/**
 * Minimal interactive prompt helpers. No dependencies — we use the
 * built-in readline so the install surface stays tiny.
 */

import readline from 'node:readline';

export function promptLine(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt with echo off, for secrets. Uses a raw-mode workaround since Node's
 * readline doesn't natively support hidden input.
 */
export function promptSecret(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Non-TTY (piped input) — just read a line, no hiding.
      return promptLine(question).then(resolve, reject);
    }
    process.stdout.write(question);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let buf = '';
    const onData = data => {
      const ch = data.toString('utf8');
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '\u0003') {
        // Ctrl-C
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        reject(new Error('Cancelled'));
      } else if (ch === '\u007f' || ch === '\b') {
        // Backspace
        if (buf.length > 0) buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

export function confirm(question, { defaultYes = false } = {}) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  return promptLine(question + suffix).then(ans => {
    if (!ans) return defaultYes;
    return /^y(es)?$/i.test(ans);
  });
}
