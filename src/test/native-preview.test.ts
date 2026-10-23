import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { runBuild, type CommandArgs } from 'nuckty';
import { serve, stop } from '../index.js';

test('native preview serves a rebuild and stops its own nginx from a Unicode path', {
    skip: process.env.NUCKTY_SERVE_NATIVE !== '1',
    timeout: 25_000,
}, async (t) => {
    assert.equal(spawnSync('which', ['nginx']).status, 0, 'native preview requires nginx on PATH');
    const messages: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);

    t.mock.method(process.stdout, 'write', (...args: Parameters<typeof process.stdout.write>) => {
        const message = String(args[0]);

        if (!message.startsWith('nuckty: ')) {
            return stdout(...args);
        }

        messages.push(message);
        const callback: unknown = args[1];
        const done = typeof callback === 'function' ? callback : args[2];

        if (typeof done === 'function') {
            process.nextTick(() => done());
        }

        return true;
    });
    const reserve = createServer();
    await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reserve.close((error) => error ? reject(error) : resolve()));
    const cwd = await mkdtemp(path.join(tmpdir(), 'nuckty preview – пример '));
    let child: ChildProcess | undefined;
    let pending: Promise<number> | undefined;
    const args: CommandArgs = { cwd, config: { targets: { default: { configDir: 'config', outDir: 'site' } } }, positional: [], flags: { port: String(port) } };
    const url = `http://127.0.0.1:${port}/`;
    try {
        await mkdir(path.join(cwd, 'config'));
        await mkdir(path.join(cwd, 'content'));
        await mkdir(path.join(cwd, 'ext'));
        await writeFile(path.join(cwd, 'config/config-nuckty.ts'), 'export default { targets: { default: { configDir: "config", outDir: "site" } }, ext: ["./ext/document.mjs"] };');
        await writeFile(path.join(cwd, 'ext/document.mjs'), 'export function register(env) { env.document.register((data) => ({ tag: false, content: data.content })); }');
        await writeFile(path.join(cwd, 'config/sitemap.yml'), '- Index [/, index.md]\n');
        await writeFile(path.join(cwd, 'config/site.json'), '{"bundles":[]}');
        await writeFile(path.join(cwd, 'content/index.md'), 'BEFORE');
        await runBuild({ command: 'build', cwd });
        assert.ok((await readFile(path.join(cwd, 'site/html/index.html'), 'utf8')).includes('BEFORE'));
        pending = serve(args, { spawn: ((command: string, argv: string[], options: SpawnOptions) => {
            child = spawn(command, argv, options);
            return child;
        }) as typeof spawn });
        let ready = false;
        for (let attempt = 0; attempt < 100 && !ready; attempt++) {
            try {
                ready = (await (await fetch(url, { signal: AbortSignal.timeout(500) })).text()).includes('BEFORE');
            } catch {
                // Wait for the preview listener.
            }
            if (!ready) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        }
        assert.equal(ready, true);
        const pidFile = path.join(cwd, '.build/nginx.pid');
        const pid = await readFile(pidFile, 'utf8');
        assert.equal(Number(pid.trim()), child!.pid);
        await writeFile(path.join(cwd, 'content/index.md'), 'AFTER');
        await runBuild({ command: 'build', cwd });
        assert.equal(await readFile(pidFile, 'utf8'), pid);
        await access(path.join(cwd, '.build/nginx-serve.conf'));
        await access(path.join(cwd, '.build/nginx-logs'));
        assert.ok((await (await fetch(url)).text()).includes('AFTER'));
        assert.equal(await stop({ ...args, flags: {} }), 0);
        assert.equal(await pending, 0);
        assert.deepEqual(messages, [
            'nuckty: built target "default" → site\n',
            'nuckty: built target "default" → site\n',
            'nuckty: sent nginx graceful stop signal\n',
        ]);
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGQUIT');
            await pending;
        }
        await rm(cwd, { recursive: true, force: true });
    }
});
