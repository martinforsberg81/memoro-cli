import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadDevDefinition,
  resolveDevPlan,
  resolveDevSessionEnvironment,
} from '../../src/mc/dev-definition.js';

function validDefinition(overrides = {}) {
  return {
    schema_version: 1,
    default_service: 'web',
    services: {
      web: {
        default_profile: 'agent',
        profiles: {
          agent: {
            start: { argv: ['npm', 'run', 'dev', '--', '--skip-containers'] },
            readiness: {
              kind: 'runtime-manifest',
              path: '.runtime/mc-dev.json',
              timeout_ms: 90_000,
            },
            resource_class: 'standard',
          },
          full: {
            start: { argv: ['npm', 'run', 'dev'] },
            readiness: {
              kind: 'runtime-manifest',
              path: '.runtime/mc-dev.json',
              timeout_ms: 120_000,
            },
            resource_class: 'heavy',
          },
        },
        dependencies: {
          manager: 'npm',
          fingerprint_files: ['package.json', 'package-lock.json'],
          install: { argv: ['npm', 'ci'] },
        },
        managed_argv_prefixes: [
          ['npm', 'run', 'dev'],
          ['npx', 'wrangler', 'dev'],
        ],
      },
    },
    ...overrides,
  };
}

describe('dev definition', () => {
  test('loads, validates, normalizes, and fingerprints schema version 1', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-dev-definition-'));
    try {
      mkdirSync(join(root, '.mc'), { recursive: true });
      writeFileSync(join(root, '.mc', 'dev.json'), JSON.stringify(validDefinition()));

      const loaded = loadDevDefinition({ worktreePath: root });
      assert.equal(loaded.path, join(root, '.mc', 'dev.json'));
      assert.match(loaded.fingerprint, /^sha256:[a-f0-9]{64}$/);
      assert.deepEqual(loaded.definition.services.web.profiles.agent.start.argv, [
        'npm', 'run', 'dev', '--', '--skip-containers',
      ]);
      assert.equal(loaded.definition.services.web.profiles.agent.resource_class, 'standard');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects unknown fields, unsafe paths, and shell-shaped commands', () => {
    const cases = [
      [
        { ...validDefinition(), typo: true },
        /unknown field "typo"/,
      ],
      [
        validDefinition({
          services: {
            ...validDefinition().services,
            web: {
              ...validDefinition().services.web,
              dependencies: {
                ...validDefinition().services.web.dependencies,
                fingerprint_files: ['../package-lock.json'],
              },
            },
          },
        }),
        /safe relative path/,
      ],
      [
        validDefinition({
          services: {
            ...validDefinition().services,
            web: {
              ...validDefinition().services.web,
              profiles: {
                ...validDefinition().services.web.profiles,
                agent: {
                  ...validDefinition().services.web.profiles.agent,
                  start: { argv: 'npm run dev' },
                },
              },
            },
          },
        }),
        /argv must be an array/,
      ],
    ];

    for (const [definition, expected] of cases) {
      assert.throws(
        () => loadDevDefinition({
          worktreePath: '/repo',
          exists: () => true,
          readFile: () => JSON.stringify(definition),
        }),
        expected,
      );
    }
  });

  test('resolves service and profile with CLI/local/global/repo-default precedence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-dev-plan-'));
    try {
      mkdirSync(join(root, '.mc'), { recursive: true });
      writeFileSync(join(root, '.mc', 'dev.json'), JSON.stringify(validDefinition()));

      const fromDefault = await resolveDevPlan({ worktreePath: root });
      assert.deepEqual(fromDefault.service, { name: 'web', source: '.mc/dev.json' });
      assert.deepEqual(fromDefault.profile, { name: 'agent', source: '.mc/dev.json' });

      const fromGlobal = await resolveDevPlan({
        worktreePath: root,
        globalConfig: { dev: { profile: 'full' } },
        localConfig: null,
      });
      assert.deepEqual(fromGlobal.profile, { name: 'full', source: '~/.memoro/config.json' });

      const fromLocal = await resolveDevPlan({
        worktreePath: root,
        globalConfig: { dev: { profile: 'agent' } },
        localConfig: { dev: { profile: 'full' } },
      });
      assert.deepEqual(fromLocal.profile, { name: 'full', source: '.mc/local.json' });

      const fromCli = await resolveDevPlan({
        worktreePath: root,
        globalConfig: { dev: { profile: 'agent' } },
        localConfig: { dev: { profile: 'agent' } },
        profileName: 'full',
      });
      assert.deepEqual(fromCli.profile, { name: 'full', source: 'cli' });
      assert.equal(fromCli.resource_class, 'heavy');
      assert.deepEqual(fromCli.start.argv, ['npm', 'run', 'dev']);
      assert.deepEqual(fromCli.dependencies.install.argv, ['npm', 'ci']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses configured services and profiles that are not declared', async () => {
    const definition = validDefinition();
    const deps = {
      exists: () => true,
      readFile: () => JSON.stringify(definition),
    };
    await assert.rejects(
      resolveDevPlan({ worktreePath: '/repo', serviceName: 'api', deps }),
      /service "api" is not declared/,
    );
    await assert.rejects(
      resolveDevPlan({ worktreePath: '/repo', profileName: 'turbo', deps }),
      /profile "turbo" is not declared for service "web"/,
    );
  });

  test('builds portable session env and soft-degrades missing or invalid definitions', async () => {
    const environment = await resolveDevSessionEnvironment({
      worktreePath: '/repo',
      globalConfig: {},
      resolvePlan: async () => ({
        service: { name: 'web' },
        profile: { name: 'agent' },
        definition_fingerprint: 'sha256:abc123',
      }),
    });
    assert.deepEqual(environment, {
      MC_DEV_SERVICE: 'web',
      MC_DEV_PROFILE: 'agent',
      MC_DEV_DEFINITION_FINGERPRINT: 'sha256:abc123',
    });

    let errorOutput = '';
    const invalid = await resolveDevSessionEnvironment({
      worktreePath: '/repo',
      globalConfig: {},
      stderr: { write: (value) => { errorOutput += value; } },
      resolvePlan: async () => {
        const error = new Error('invalid profile');
        error.code = 'DEV_DEFINITION_INVALID';
        throw error;
      },
    });
    assert.deepEqual(invalid, {});
    assert.match(errorOutput, /dev definition ignored \(invalid profile\); continuing/);

    errorOutput = '';
    const missing = await resolveDevSessionEnvironment({
      worktreePath: '/repo',
      globalConfig: {},
      stderr: { write: (value) => { errorOutput += value; } },
      resolvePlan: async () => {
        const error = new Error('missing');
        error.code = 'DEV_DEFINITION_NOT_FOUND';
        throw error;
      },
    });
    assert.deepEqual(missing, {});
    assert.equal(errorOutput, '');
  });
});
