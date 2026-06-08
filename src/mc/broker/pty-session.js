import { EventEmitter } from 'node:events';

import { RingBuffer } from './ring-buffer.js';

export class PtySession extends EventEmitter {
  constructor({
    id,
    name = null,
    cwd,
    tool = null,
    launchSpec,
    argv = [],
    launchOptions = {},
    cols = 80,
    rows = 24,
    termName = 'xterm-256color',
    env = {},
    ptyFactory,
    clock = Date,
    ringBytes = 2 * 1024 * 1024,
  }) {
    super();
    if (!id) throw new TypeError('id is required');
    if (!cwd) throw new TypeError('cwd is required');
    if (!launchSpec?.bin || typeof launchSpec.args !== 'function') {
      throw new TypeError('launchSpec with bin and args(argv) is required');
    }
    if (!ptyFactory?.spawn) throw new TypeError('ptyFactory.spawn is required');

    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.tool = tool;
    this.launchSpec = launchSpec;
    this.argv = argv;
    this.launchOptions = launchOptions;
    this.cols = cols;
    this.rows = rows;
    this.termName = termName;
    this.env = env;
    this.ptyFactory = ptyFactory;
    this.clock = clock;
    this.ring = new RingBuffer({ maxBytes: ringBytes });

    this.pty = null;
    this.startedAt = null;
    this.lastOutputAt = null;
    this.lastInputAt = null;
    this.exit = null;
  }

  start() {
    if (this.pty) return this;

    this.startedAt = this._now();
    this.lastOutputAt = this.startedAt;
    this.pty = this.ptyFactory.spawn(this.launchSpec.bin, this.launchSpec.args(this.argv, this.launchOptions), {
      name: this.termName,
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: this.env,
    });

    this.pty.onData((data) => {
      this.lastOutputAt = this._now();
      this.ring.append(data);
      this.emit('data', data);
    });

    this.pty.onExit((event) => {
      this.exit = {
        code: event?.exitCode ?? null,
        signal: event?.signal ?? null,
        at: new Date(this._now()).toISOString(),
      };
      this.emit('exit', event);
    });

    return this;
  }

  write(data) {
    this._assertStarted();
    this.lastInputAt = this._now();
    this.pty.write(data);
  }

  writeDispatchedMessage(message) {
    this.write(`${message}\r`);
  }

  resize(cols, rows) {
    this._assertStarted();
    this.cols = cols;
    this.rows = rows;
    this.pty.resize(cols, rows);
  }

  kill(signal) {
    this._assertStarted();
    this.pty.kill(signal);
  }

  recentOutput() {
    return this.ring.toString('utf8');
  }

  status() {
    return {
      id: this.id,
      name: this.name,
      tool: this.tool,
      cwd: this.cwd,
      started_at: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      last_output_at: this.lastOutputAt ? new Date(this.lastOutputAt).toISOString() : null,
      last_input_at: this.lastInputAt ? new Date(this.lastInputAt).toISOString() : null,
      pty_pid: this.pty?.pid ?? null,
      exit: this.exit,
    };
  }

  _assertStarted() {
    if (!this.pty) throw new Error('PTY session has not started');
  }

  _now() {
    if (typeof this.clock === 'function') return this.clock();
    if (typeof this.clock?.now === 'function') return this.clock.now();
    return Date.now();
  }
}
