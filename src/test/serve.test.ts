import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { killNginxByPid, pidFileFor, stop, type KillSpawn } from '../index.js';
import type { CommandArgs } from 'nuckty';

for (const outcome of ['success', 'error', 'denied', 'unrelated', 'reused', 'invalid', 'absent'] as const) {
    test(`stop: ${outcome} has truthful result and preserves nginx-owned pid file`, async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-stop-'));
        const pidFile = pidFileFor(dir);
        await mkdir(path.dirname(pidFile), { recursive: true });
        const content = outcome === 'invalid' ? 'invalid' : '424242';
        if (outcome !== 'absent') {
            await writeFile(pidFile, content);
        }
        let signals = 0;
        let inspections = 0;
        const identity = `Tue Sep 22 10:00:00 2026 nginx: master process nginx -c ${path.join(dir, '.build', 'nginx.conf')}`;
        try {
            const options = {
                pidFile,
                inspectProcess: async () => {
                    inspections++;
                    return outcome === 'unrelated' ? 'other process' : outcome === 'reused' && inspections === 2 ? `changed ${identity}` : identity;
                },
                spawnKill: (): KillSpawn => {
                    signals++;
                    return { on(event, listener) {
                        if (event === (outcome === 'error' ? 'error' : 'exit')) {
                            queueMicrotask(() => listener(outcome === 'error' ? new Error('ENOENT') : outcome === 'denied' ? 1 : 0));
                        }
                    } };
                },
            };
            const expected = outcome === 'success' ? 'sent' : outcome === 'absent' ? 'absent' : 'failed';
            assert.equal(await killNginxByPid(options), expected);
            assert.equal(signals, ['success', 'error', 'denied'].includes(outcome) ? 1 : 0);
            if (outcome !== 'absent') {
                assert.equal(await readFile(pidFile, 'utf8'), content);
            }
            inspections = 0;
            const stdout = process.stdout.write;
            const stderr = process.stderr.write;
            let output = '';
            process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof stdout;
            process.stderr.write = (() => true) as typeof stderr;
            try {
                const args: CommandArgs = { cwd: dir, config: { targets: {} }, positional: [], flags: {} };
                assert.equal(await stop(args, options), expected === 'failed' ? 1 : 0);
                assert.equal(output.includes('graceful stop signal'), expected === 'sent');
            } finally {
                process.stdout.write = stdout;
                process.stderr.write = stderr;
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
}

import { serve } from '../index.js';
import { EventEmitter } from 'node:events';
import type { spawn, ChildProcess } from 'node:child_process';

for (const mode of ['selected', 'missing-config', 'unknown', 'invalid-port', 'default', 'spawn-error', 'unknown-flag', 'empty-flag', 'too-many-targets'] as const) {
    test(`serve command: ${mode}`, async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), 'nuckty-serve-start-'));
        const stderr = process.stderr.write;
        process.stderr.write = (() => true) as typeof stderr;
        try {
            await mkdir(path.join(cwd, 'chosen', 'html'), { recursive: true });
            await mkdir(path.join(cwd, 'first', 'html'), { recursive: true });
            if (mode !== 'missing-config') {
                await mkdir(path.join(cwd, '.build'), { recursive: true });
                await writeFile(path.join(cwd, '.build/nginx.conf'), '# built fixture configuration');
            }
            const args: CommandArgs = {
                cwd,
                config: { targets: {
                    first: { configDir: 'config', outDir: 'first' },
                    chosen: { configDir: 'config', outDir: 'chosen' },
                } },
                positional: mode === 'default' ? [] : mode === 'too-many-targets' ? ['chosen', 'first'] : [mode === 'unknown' ? 'typo' : 'chosen'],
                flags: mode === 'empty-flag' ? { '': true } : mode === 'unknown-flag' ? { prt: true } : { port: mode === 'invalid-port' ? '0' : '8765' },
            };
            let cwdRead = false;
            if (mode === 'unknown-flag' || mode === 'empty-flag' || mode === 'too-many-targets') {
                Object.defineProperty(args, 'cwd', {
                    get() {
                        cwdRead = true;
                        throw new Error('cwd was read before argument validation');
                    },
                });
            }
            let launched = false;
            let resolvedNginx = false;
            const fakeSpawn = ((_bin: string, options: string[]) => {
                launched = true;
                assert.deepEqual(options, ['-c', path.join(cwd, '.build', 'nginx-serve.conf'), '-g', 'daemon off;']);
                const child = new EventEmitter() as ChildProcess;
                queueMicrotask(() => mode === 'spawn-error' ? child.emit('error', new Error('ENOENT')) : child.emit('exit', 0));
                return child;
            }) as typeof spawn;
            const result = await serve(args, {
                resolveNginx: async () => { resolvedNginx = true; return '/owned/fixture/nginx'; },
                spawn: fakeSpawn,
            });
            const rejected = ['missing-config', 'unknown', 'invalid-port', 'unknown-flag', 'empty-flag', 'too-many-targets'].includes(mode);
            assert.equal(result, rejected || mode === 'spawn-error' ? 1 : 0);
            assert.equal(launched, !rejected);
            assert.equal(resolvedNginx, !rejected);
            assert.equal(cwdRead, false);
            if (rejected) {
                await assert.rejects(readFile(path.join(cwd, '.build', 'nginx-serve.conf'), 'utf8'), { code: 'ENOENT' });
            }
            if (launched) {
                const config = await readFile(path.join(cwd, '.build', 'nginx-serve.conf'), 'utf8');
                assert.ok(config.includes(path.join(cwd, mode === 'default' ? 'first' : 'chosen')));
                assert.ok(config.includes('listen 127.0.0.1:8765;'));
                assert.ok(config.includes(path.join(cwd, '.build', 'nginx.pid')));
            }
        } finally {
            process.stderr.write = stderr;
            await rm(cwd, { recursive: true, force: true });
        }
    });
}

test('stop: rejects --dry-run before inspecting the pid or sending a signal', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-stop-args-'));
    const pidFile = pidFileFor(dir);
    await mkdir(path.dirname(pidFile), { recursive: true });
    await writeFile(pidFile, '424242');
    let inspections = 0;
    let signals = 0;
    const stderr = process.stderr.write;
    let output = '';
    process.stderr.write = ((chunk: string) => { output += chunk; return true; }) as typeof stderr;
    try {
        const args: CommandArgs = { cwd: dir, config: { targets: {} }, positional: [], flags: { 'dry-run': true } };
        const result = await stop(args, {
            pidFile,
            inspectProcess: async () => {
                inspections++;
                return `Tue Sep 22 10:00:00 2026 nginx: master process nginx -c ${path.join(dir, '.build', 'nginx.conf')}`;
            },
            spawnKill: (): KillSpawn => {
                signals++;
                return { on(_event, listener) { queueMicrotask(() => listener(0)); } };
            },
        });
        assert.equal(result, 1);
        assert.match(output, /stop does not accept arguments/);
        assert.equal(inspections, 0);
        assert.equal(signals, 0);
        assert.equal(await readFile(pidFile, 'utf8'), '424242');
    } finally {
        process.stderr.write = stderr;
        await rm(dir, { recursive: true, force: true });
    }
});

for (const localeCase of [
    { name: 'inherited UTF-8 LC_ALL', all: 'ru_RU.UTF-8', ctype: 'C', expectedCtype: 'ru_RU.UTF-8' },
    { name: 'inherited LC_ALL=C', all: 'C', ctype: 'ru_RU.UTF-8', expectedCtype: 'C.UTF-8' },
    { name: 'unset LC_ALL with UTF-8 LC_CTYPE', all: undefined, ctype: 'ru_RU.UTF-8', expectedCtype: 'ru_RU.UTF-8' },
    { name: 'unset LC_ALL with C LC_CTYPE', all: undefined, ctype: 'C', expectedCtype: 'C.UTF-8' },
] as const) {
    test(`stop: ps locale keeps Unicode config paths (${localeCase.name})`, { skip: process.platform === 'win32' }, async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-stop Ω-'));
        const binDir = path.join(dir, 'fake bin');
        const configPath = path.join(dir, 'consumer Ω', '.build', 'nginx-serve.conf');
        const pidFile = path.join(path.dirname(configPath), 'nginx.pid');
        const callsFile = path.join(dir, 'calls.jsonl');
        await mkdir(binDir, { recursive: true });
        await mkdir(path.dirname(pidFile), { recursive: true });
        await writeFile(pidFile, '424242');
        await writeFile(path.join(binDir, 'ps'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.NUCKTY_TEST_CALLS, JSON.stringify({ command: 'ps', args: process.argv.slice(2), timeLocale: process.env.LC_TIME, allLocale: process.env.LC_ALL, ctypeLocale: process.env.LC_CTYPE }) + '\\n');
if (process.env.LC_TIME !== 'C' || process.env.LC_ALL !== undefined || process.env.LC_CTYPE !== process.env.NUCKTY_TEST_CTYPE) process.exit(2);
process.stdout.write('Mon Sep 28 13:00:00 2026 nginx: master process /opt/homebrew/bin/nginx -c ' + process.env.NUCKTY_TEST_CONFIG + ' -g daemon off;\\n');
`, { mode: 0o755 });
        await writeFile(path.join(binDir, 'kill'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.NUCKTY_TEST_CALLS, JSON.stringify({ command: 'kill', args: process.argv.slice(2) }) + '\\n');
` , { mode: 0o755 });

        const original = {
            path: process.env.PATH,
            all: process.env.LC_ALL,
            ctype: process.env.LC_CTYPE,
            time: process.env.LC_TIME,
            config: process.env.NUCKTY_TEST_CONFIG,
            calls: process.env.NUCKTY_TEST_CALLS,
            testCtype: process.env.NUCKTY_TEST_CTYPE,
        };
        process.env.PATH = `${binDir}${path.delimiter}${original.path ?? ''}`;
        if (localeCase.all === undefined) delete process.env.LC_ALL;
        else process.env.LC_ALL = localeCase.all;
        process.env.LC_CTYPE = localeCase.ctype;
        process.env.LC_TIME = 'ru_RU.UTF-8';
        process.env.NUCKTY_TEST_CONFIG = configPath;
        process.env.NUCKTY_TEST_CALLS = callsFile;
        process.env.NUCKTY_TEST_CTYPE = localeCase.expectedCtype;
        try {
            assert.equal(await killNginxByPid({ pidFile }), 'sent');
            assert.equal(process.env.LC_ALL, localeCase.all);
            assert.equal(process.env.LC_CTYPE, localeCase.ctype);
            assert.equal(process.env.LC_TIME, 'ru_RU.UTF-8');
            const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
                command: string;
                args: string[];
                timeLocale?: string;
                allLocale?: string;
                ctypeLocale?: string;
            });
            const psCalls = calls.filter((call) => call.command === 'ps');
            assert.equal(psCalls.length, 2);
            for (const call of psCalls) {
                assert.equal(call.timeLocale, 'C');
                assert.equal(call.allLocale, undefined);
                assert.equal(call.ctypeLocale, localeCase.expectedCtype);
                assert.ok(call.args.includes('-ww'));
            }
            assert.deepEqual(calls.find((call) => call.command === 'kill')?.args, ['-QUIT', '424242']);
        } finally {
            if (original.path === undefined) delete process.env.PATH;
            else process.env.PATH = original.path;
            if (original.all === undefined) delete process.env.LC_ALL;
            else process.env.LC_ALL = original.all;
            if (original.ctype === undefined) delete process.env.LC_CTYPE;
            else process.env.LC_CTYPE = original.ctype;
            if (original.time === undefined) delete process.env.LC_TIME;
            else process.env.LC_TIME = original.time;
            if (original.config === undefined) delete process.env.NUCKTY_TEST_CONFIG;
            else process.env.NUCKTY_TEST_CONFIG = original.config;
            if (original.calls === undefined) delete process.env.NUCKTY_TEST_CALLS;
            else process.env.NUCKTY_TEST_CALLS = original.calls;
            if (original.testCtype === undefined) delete process.env.NUCKTY_TEST_CTYPE;
            else process.env.NUCKTY_TEST_CTYPE = original.testCtype;
            await rm(dir, { recursive: true, force: true });
        }
    });
}

for (const destination of ['.build', '.build/nginx-serve.conf', '.build/nginx.pid', '.build/nginx-logs', '.build/nginx-logs/nuckty_access.log', '.build/nginx-logs/nuckty_error.log']) {
    test(`serve refuses linked output ${destination} before writes or spawn`, async (t) => {
        const root = await mkdtemp(path.join(tmpdir(), 'serve-owned-output-'));
        const { symlink } = await import('node:fs/promises');
        let launched = false;
        t.mock.method(process.stderr, 'write', () => true);

        try {
            await mkdir(path.join(root, 'site/html'), { recursive: true });
            await mkdir(path.join(root, 'outside'));
            await writeFile(path.join(root, 'outside/marker'), 'PRESERVE');
            const linked = path.join(root, destination);

            await mkdir(path.dirname(linked), { recursive: true });
            const directory = destination === '.build' || destination.endsWith('nginx-logs');

            await symlink(path.join(root, directory ? 'outside' : 'outside/marker'), linked);
            const result = await serve({ cwd: root, config: { targets: { main: { configDir: 'config', outDir: 'site' } } }, positional: [], flags: {} }, {
                resolveNginx: async () => { launched = true; throw new Error('must refuse before resolution'); },
            });

            assert.equal(result, 1);
            assert.equal(launched, false);
            assert.equal(await readFile(path.join(root, 'outside/marker'), 'utf8'), 'PRESERVE');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test('serve retains a symbolic consumer root while guarding real output paths', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'serve-symbolic-consumer-'));
    const { symlink } = await import('node:fs/promises');
    const actual = path.join(parent, 'actual');
    const alias = path.join(parent, 'alias');
    let configArgument = '';

    try {
        await mkdir(path.join(actual, 'site/html'), { recursive: true });
        await mkdir(path.join(actual, '.build'));
        await writeFile(path.join(actual, '.build/nginx.conf'), '# built fixture configuration');
        await symlink(actual, alias);
        const result = await serve({ cwd: alias, config: { targets: { main: { configDir: 'config', outDir: 'site' } } }, positional: [], flags: {} }, {
            resolveNginx: async () => '/fixture/nginx',
            spawn: ((_bin: string, argv: string[]) => {
                configArgument = argv[1]!;
                const child = new EventEmitter() as ChildProcess;

                queueMicrotask(() => child.emit('exit', 0));

                return child;
            }) as typeof spawn,
        });

        assert.equal(result, 0);
        assert.equal(configArgument, path.join(alias, '.build/nginx-serve.conf'));
        const configuration = await readFile(path.join(actual, '.build/nginx-serve.conf'), 'utf8');

        assert.ok(configuration.includes(path.join(alias, 'site')));
        assert.ok(configuration.includes(path.join(alias, '.build/nginx.pid')));
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

