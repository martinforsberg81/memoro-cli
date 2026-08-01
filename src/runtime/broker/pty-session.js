import { EventEmitter } from 'node:events';

import { RingBuffer } from './ring-buffer.js';
import { createStartupMessageController } from '../../mc/wrap-startup-message.js';
import { writeToPty } from '../../mc/pty-write.js';

const STARTUP_MESSAGE_IDLE_MS = 1500;

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
    startupMessageDelayMs = STARTUP_MESSAGE_IDLE_MS,
    startupMessageSetTimeoutFn = globalThis.setTimeout,
    startupMessageClearTimeoutFn = globalThis.clearTimeout,
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
    this.startupMessageDelayMs = startupMessageDelayMs;
    this.startupMessageSetTimeoutFn = startupMessageSetTimeoutFn;
    this.startupMessageClearTimeoutFn = startupMessageClearTimeoutFn;

    this.pty = null;
    this.startedAt = null;
    this.lastOutputAt = null;
    this.lastInputAt = null;
    this.exit = null;
    this.startupMessageController = null;
    this.handoffMessageController = null;
  }

  start() {
    if (this.pty) return this;

    this.startedAt = this._now();
    this.lastOutputAt = this.startedAt;
    const startupMessage = this.launchSpec.startupMessageDelivery === 'deferred-pty'
      ? this.launchOptions.startupMessage
      : null;
    const handoffUserMessage = this.launchOptions.handoffUserMessage;
    if (startupMessage && handoffUserMessage) {
      throw new Error('startup and handoff messages must be delivered as one user turn');
    }
    const providerLaunchOptions = {
      ...this.launchOptions,
      // Handoff is a broker-delivered user turn. It must never reach adapter
      // argv rendering, process listings, or a provider-specific system-prompt
      // option.
      handoffUserMessage: null,
    };
    const spawnOptions = this.launchSpec.startupMessageDelivery === 'deferred-pty'
      ? { ...providerLaunchOptions, startupMessage: null }
      : providerLaunchOptions;

    const spawnPlan = typeof this.launchSpec.spawn === 'function'
      ? this.launchSpec.spawn(this.argv, spawnOptions)
      : { bin: this.launchSpec.bin, args: this.launchSpec.args(this.argv, spawnOptions) };

    this.pty = this.ptyFactory.spawn(spawnPlan.bin, spawnPlan.args, {
      name: this.termName,
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: this.env,
    });

    this.startupMessageController = createStartupMessageController({
      message: startupMessage,
      delayMs: this.startupMessageDelayMs,
      deliver: (message) => {
        writeToPty(this.pty, message, this.launchSpec);
      },
      setTimeoutFn: this.startupMessageSetTimeoutFn,
      clearTimeoutFn: this.startupMessageClearTimeoutFn,
    });
    this.handoffMessageController = createStartupMessageController({
      message: handoffUserMessage,
      delayMs: this.startupMessageDelayMs,
      deliver: (message) => {
        writeToPty(this.pty, message, this.launchSpec);
      },
      setTimeoutFn: this.startupMessageSetTimeoutFn,
      clearTimeoutFn: this.startupMessageClearTimeoutFn,
    });

    this.pty.onData((data) => {
      this.lastOutputAt = this._now();
      this.ring.append(data);
      this.emit('data', data);
      const promptReady = typeof this.launchSpec.isUserMessagePromptReady === 'function'
        ? this.launchSpec.isUserMessagePromptReady({
          recentOutput: this.recentOutput(),
          latestOutput: data,
        })
        : true;
      if (promptReady) {
        this.startupMessageController?.schedule();
        this.handoffMessageController?.schedule();
      } else {
        this.startupMessageController?.pause();
        this.handoffMessageController?.pause();
      }
    });

    this.pty.onExit((event) => {
      this.startupMessageController?.cancel();
      this.handoffMessageController?.cancel('provider-exited-before-handoff-delivery');
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
    this._assertStarted();
    this.lastInputAt = this._now();
    writeToPty(this.pty, message, this.launchSpec);
  }

  waitForHandoffDelivery() {
    return this.handoffMessageController?.waitForDelivery()
      || Promise.resolve({ ok: true, skipped: true });
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
