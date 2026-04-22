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
 * Prompt with echo off, for secrets.
 *
 * Handles:
 *   - Typed input (character by character)
 *   - Pasted input via bracketed-paste mode (ESC[200~ ... ESC[201~)
 *   - Pasted input without bracketed paste (one big chunk of text)
 *   - Ctrl-C (reject) / Ctrl-D (submit whatever's there) / backspace
 *   - Non-TTY stdin (piped input) — falls through to plain readline
 *
 * Also strips any ANSI control sequences that leak into the buffer —
 * belt + braces defence against terminals that emit escape codes outside
 * bracketed paste mode.
 */
export function promptSecret(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      return promptLine(question).then(resolve, reject);
    }
    process.stdout.write(question);

    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let buf = '';
    let escBuf = ''; // in-flight escape sequence accumulator
    let inPaste = false;

    const finish = (err, val) => {
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(stripAnsi(val));
    };

    const onData = data => {
      const str = data.toString('utf8');
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];

        // Escape-sequence accumulator — swallows control sequences so they
        // don't pollute the buffer, and recognises bracketed-paste markers.
        if (escBuf.length > 0 || ch === '\x1b') {
          escBuf += ch;
          if (escBuf === '\x1b[200~') { inPaste = true;  escBuf = ''; continue; }
          if (escBuf === '\x1b[201~') { inPaste = false; escBuf = ''; continue; }
          // Terminating byte of a CSI sequence ends it.
          if (escBuf.length > 2 && /[@-~]/.test(ch)) { escBuf = ''; continue; }
          // Safety cap — ignore anything longer than a reasonable escape.
          if (escBuf.length > 16) { escBuf = ''; }
          continue;
        }

        // Submit on CR/LF — unless we're mid-paste (pasted content can
        // legitimately contain newlines; tokens don't, but be safe).
        if (ch === '\r' || ch === '\n') {
          if (inPaste) continue;
          return finish(null, buf);
        }
        // Ctrl-C
        if (ch === '\u0003') return finish(new Error('Cancelled'), null);
        // Ctrl-D
        if (ch === '\u0004') return finish(null, buf);
        // Backspace / DEL
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) buf = buf.slice(0, -1);
          continue;
        }
        // Ignore other C0 control codes; accept everything else.
        if (ch < ' ' && ch !== '\t') continue;
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

/**
 * Strip ANSI CSI and OSC sequences from a string. Keeps tokens clean
 * even if something slipped past the escape-buffer logic above.
 */
function stripAnsi(s) {
  if (!s) return '';
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b\][^\x07]*\x07/g, '')      // OSC (terminated by BEL)
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, ''); // DCS/SOS/PM/APC
}
