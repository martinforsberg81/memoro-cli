/**
 * Minimal interactive prompt helpers. No dependencies — we use the
 * built-in readline + a muted Writable for hidden input.
 */

import readline from 'node:readline';
import { Writable } from 'node:stream';

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
 * Prompt with hidden input, using readline + a muted Writable.
 *
 * Approach (standard Node idiom): wrap process.stdout in a Writable that
 * silently drops everything after the question has been printed. readline
 * still reads a line correctly — including pasted content, bracketed-paste
 * sequences, and backspace — but nothing is echoed back to the terminal.
 *
 * Non-TTY stdin (piped input) falls through to plain promptLine.
 */
export function promptSecret(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      return promptLine(question).then(resolve, reject);
    }

    const muted = new MutedWritable();
    const rl = readline.createInterface({
      input: process.stdin,
      output: muted,
      terminal: true,
    });

    // Write the prompt ourselves BEFORE muting, so readline's own echo is
    // what gets silenced.
    process.stdout.write(question);
    muted.mute();

    rl.question('', answer => {
      rl.close();
      // readline swallows the trailing newline from the user hitting return,
      // so emit one so the next line of output renders below the prompt.
      process.stdout.write('\n');
      resolve(stripAnsi(answer).trim());
    });

    rl.on('SIGINT', () => {
      rl.close();
      process.stdout.write('\n');
      reject(new Error('Cancelled'));
    });
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
 * Writable stream that buffers writes until `.mute()` is called, then
 * drops everything. Used to silence readline's character echo during
 * hidden-input prompts.
 */
class MutedWritable extends Writable {
  #muted = false;
  mute() { this.#muted = true; }
  _write(chunk, _encoding, callback) {
    if (!this.#muted) process.stdout.write(chunk);
    callback();
  }
}

/**
 * Strip ANSI CSI and OSC sequences from a string. Belt + braces: in the
 * unlikely event readline passes an escape sequence through, we don't
 * store it as part of the secret.
 */
export function stripAnsi(s) {
  if (!s) return '';
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b\][^\x07]*\x07/g, '')      // OSC (BEL-terminated)
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, ''); // DCS/SOS/PM/APC
}
