import { EventEmitter } from 'node:events';

import { PtySession } from './pty-session.js';

export class BrokerSessionManager extends EventEmitter {
  constructor({ ptyFactory, clock = Date, sessionFactory = null } = {}) {
    super();
    if (!ptyFactory?.spawn && !sessionFactory) {
      throw new TypeError('ptyFactory.spawn or sessionFactory is required');
    }
    this.ptyFactory = ptyFactory;
    this.clock = clock;
    this.sessionFactory = sessionFactory;
    this.sessions = new Map();
  }

  launch(spec) {
    if (!spec?.id) throw new TypeError('session id is required');
    if (this.sessions.has(spec.id)) {
      throw new Error(`broker session already exists: ${spec.id}`);
    }

    const session = this._makeSession(spec);
    this.sessions.set(spec.id, session);
    session.on('data', (data) => this.emit('data', { id: spec.id, data }));
    session.on('exit', (event) => this.emit('exit', { id: spec.id, event }));
    try {
      session.start();
    } catch (err) {
      this.sessions.delete(spec.id);
      throw err;
    }
    return this.status(spec.id);
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  list() {
    return [...this.sessions.keys()].map((id) => this.status(id));
  }

  status(id) {
    const session = this.get(id);
    if (!session) return null;
    const s = session.status();
    return {
      ...s,
      session_state: s.exit ? 'dead' : 'live',
      attachable: !s.exit,
    };
  }

  write(id, data) {
    const session = this._require(id);
    session.write(data);
    return { ok: true };
  }

  dispatch(id, message) {
    const session = this._require(id);
    session.writeDispatchedMessage(message);
    return { ok: true };
  }

  resize(id, cols, rows) {
    const session = this._require(id);
    session.resize(cols, rows);
    return { ok: true };
  }

  stop(id, signal = 'SIGTERM') {
    const session = this._require(id);
    session.kill(signal);
    return { ok: true };
  }

  remove(id) {
    return this.sessions.delete(id);
  }

  _makeSession(spec) {
    if (this.sessionFactory) return this.sessionFactory(spec);
    return new PtySession({
      ...spec,
      ptyFactory: this.ptyFactory,
      clock: this.clock,
    });
  }

  _require(id) {
    const session = this.get(id);
    if (!session) throw new Error(`unknown broker session: ${id}`);
    return session;
  }
}
