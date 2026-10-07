import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import { request } from 'undici';
import { isLoopback, startSupervisor, type Supervisor, type WorkerProcess } from '../src/supervisor.js';

type Handler = (req: IncomingMessage, res: ServerResponse, worker: FakeWorker) => void;

/** Stands in for a forked `cli.js serve`: a real HTTP server on port 0 that reports its port over "IPC". */
class FakeWorker extends EventEmitter implements WorkerProcess {
  static count = 0;
  readonly id = ++FakeWorker.count;
  readonly pid = 10_000 + this.id;
  readonly received: unknown[] = [];
  killed = false;
  private readonly server: Server;

  constructor(handler: Handler, listen = true) {
    super();
    this.server = createServer((req, res) => handler(req, res, this));
    if (listen) {
      this.server.listen(0, '127.0.0.1', () => {
        this.emit('message', { type: 'listening', port: (this.server.address() as AddressInfo).port });
      });
    }
  }

  send(message: unknown): boolean {
    this.received.push(message);
    return true;
  }

  kill(): boolean {
    if (this.killed) return true;
    this.killed = true;
    this.server.closeAllConnections();
    this.server.close();
    setImmediate(() => this.emit('exit', null));
    return true;
  }

  /** A crash: the process is gone, its sockets with it. */
  crash(): void {
    this.kill();
  }
}

const whoAmI: Handler = (req, res, w) => {
  req.resume();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ worker: w.id, url: req.url }));
};

let sup: Supervisor | undefined;
afterEach(async () => {
  await sup?.close();
  sup = undefined;
});

async function start(handler: Handler, extra: Partial<Parameters<typeof startSupervisor>[0]> = {}) {
  const workers: FakeWorker[] = [];
  sup = await startSupervisor({
    host: '127.0.0.1',
    port: 0,
    controlPort: 0,
    drainMs: 5_000,
    restartDelaysMs: [10, 10, 10],
    forkWorker: () => {
      const w = new FakeWorker(handler);
      workers.push(w);
      return w;
    },
    log: () => {},
    ...extra,
  });
  return { workers, url: `http://127.0.0.1:${sup.port}`, control: `http://127.0.0.1:${sup.controlPort}` };
}

const json = async (url: string) => {
  const res = await request(url);
  return { status: res.statusCode, body: (await res.body.json()) as Record<string, unknown> };
};

describe('isLoopback', () => {
  it('accepts only loopback peers', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true, a);
    for (const a of ['10.0.0.2', '::ffff:10.0.0.2', '0.0.0.0', undefined]) assert.equal(isLoopback(a), false, String(a));
  });
});

describe('supervisor', () => {
  it('forwards requests, with method, path, headers and body, to the active worker', async () => {
    const { url } = await start((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => {
        res.writeHead(201, { 'x-echo': String(req.headers['x-api-key']) });
        res.end(`${req.method} ${req.url} ${Buffer.concat(parts).toString()}`);
      });
    });
    const res = await request(`${url}/v1/messages?beta=true`, { method: 'POST', headers: { 'x-api-key': 'sk-ant-x' }, body: 'hello' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.headers['x-echo'], 'sk-ant-x');
    assert.equal(await res.body.text(), 'POST /v1/messages?beta=true hello');
  });

  it('streams: the client sees the first SSE event before the worker writes the second', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { url } = await start((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      void gate.then(() => res.end('data: two\n\n'));
    });
    const res = await request(url);
    const it = res.body[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(Buffer.from(first.value as Uint8Array).toString(), 'data: one\n\n');
    release();
    let rest = '';
    for (let n = await it.next(); !n.done; n = await it.next()) rest += Buffer.from(n.value as Uint8Array).toString();
    assert.equal(rest, 'data: two\n\n');
  });

  it('reload points new requests at a new worker and drains the old one', async () => {
    const { url, control, workers } = await start(whoAmI);
    assert.equal((await json(url)).body['worker'], workers[0]!.id);

    const reload = await request(`${control}/reload`, { method: 'POST' });
    assert.equal(reload.statusCode, 200);
    assert.equal(((await reload.body.json()) as { pid: number }).pid, workers[1]!.pid);

    assert.equal((await json(url)).body['worker'], workers[1]!.id);
    assert.deepEqual(workers[0]!.received, [{ type: 'drain' }]);
    await sleep(20);
    assert.equal(workers[0]!.killed, true, 'an idle old worker goes away at once');
    assert.equal(workers[1]!.killed, false);
  });

  it('lets a stream open on the old worker finish after the switch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { url, workers } = await start((req, res, w) => {
      req.resume();
      if (w.id !== FakeWorker.count || req.url !== '/slow') return void res.writeHead(200).end(`w${w.id}`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: start\n\n');
      void gate.then(() => res.end('data: end\n\n'));
    });
    const slow = await request(`${url}/slow`);
    const it = slow.body[Symbol.asyncIterator]();
    await it.next(); // the stream is open on worker 0

    assert.equal((await sup!.reload()).ok, true);
    assert.equal(await (await request(url)).body.text(), `w${workers[1]!.id}`);
    assert.equal(workers[0]!.killed, false, 'the old worker still serves its open stream');

    release();
    let rest = '';
    for (let n = await it.next(); !n.done; n = await it.next()) rest += Buffer.from(n.value as Uint8Array).toString();
    assert.equal(rest, 'data: end\n\n');
    await sleep(20);
    assert.equal(workers[0]!.killed, true, 'retired once its last request ended');
  });

  it('cuts what is left on the old worker once RELOAD_DRAIN_MS is over', async () => {
    const { url, workers } = await start(
      (req, res, w) => {
        req.resume();
        if (w.id !== FakeWorker.count || req.url !== '/forever') return void res.writeHead(200).end('ok');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: start\n\n');
      },
      { drainMs: 100 },
    );
    const forever = await request(`${url}/forever`);
    const it = forever.body[Symbol.asyncIterator]();
    await it.next();
    await sup!.reload();
    await assert.rejects(async () => {
      for (let n = await it.next(); !n.done; n = await it.next());
    });
    assert.equal(workers[0]!.killed, true);
  });

  it('refuses a second reload while one is switching', async () => {
    // The reload's worker takes 200 ms to listen, so the switch is observably in progress
    // (an instant fake worker lets the first reload finish before the second POST lands).
    let forks = 0;
    const { control } = await start(whoAmI, {
      forkWorker: () => {
        if (++forks === 1) return new FakeWorker(whoAmI);
        const slow = new FakeWorker(whoAmI, false);
        setTimeout(() => slow.emit('message', { type: 'listening', port: 1 }), 200);
        return slow;
      },
    });
    const [a, b] = await Promise.all([
      request(`${control}/reload`, { method: 'POST' }),
      request(`${control}/reload`, { method: 'POST' }),
    ]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    await Promise.all([a.body.dump(), b.body.dump()]);
  });

  it('restarts a crashed worker and answers 503 while there is none', async () => {
    const { url, workers } = await start(whoAmI, { restartDelaysMs: [150] });
    workers[0]!.crash();
    await sleep(20);
    const down = await json(`${url}/healthz`);
    assert.equal(down.status, 503);
    assert.deepEqual(down.body, { ok: false, error: 'worker down' });
    const api = await request(`${url}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(api.statusCode, 503);
    assert.equal(((await api.body.json()) as { type: string }).type, 'error', 'Anthropic-shaped, so Claude Code retries');

    await sleep(300);
    assert.equal((await json(url)).body['worker'], workers[1]!.id);
  });

  it('gives up after the last restart delay instead of looping forever', async () => {
    let forks = 0;
    sup = await startSupervisor({
      host: '127.0.0.1',
      port: 0,
      controlPort: 0,
      drainMs: 5_000,
      restartDelaysMs: [10, 10],
      startupTimeoutMs: 1_000,
      forkWorker: () => {
        forks++;
        const w = new FakeWorker(whoAmI, false);
        setImmediate(() => w.emit('exit', 1)); // dies before listening
        return w;
      },
      log: () => {},
    });
    await sleep(150);
    assert.equal(forks, 3, 'first start + one per restart delay');
    assert.equal((await json(`http://127.0.0.1:${sup.port}/healthz`)).status, 503);
  });
});
