import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler, originAllowed } from '../services/scroll-relay-lambda/relay.mjs';

function rig() {
  const rows = new Map(); // "pk|sk" -> item
  const sent = []; // { cid, data }
  const gone = new Set();
  const db = {
    put: async (it) => { rows.set(`${it.pk}|${it.sk}`, { ...it }); },
    get: async (k) => rows.get(`${k.pk}|${k.sk}`),
    del: async (k) => { rows.delete(`${k.pk}|${k.sk}`); },
    query: async (pk) => [...rows.values()].filter((r) => r.pk === pk),
  };
  const post = async (cid, data) => {
    if (gone.has(cid)) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    sent.push({ cid, data: JSON.parse(data) });
  };
  let t = 1000;
  const h = makeHandler({ db, post, now: () => (t += 1000) });
  const connect = (cid, s, r, origin) => h({
    requestContext: { routeKey: '$connect', connectionId: cid },
    queryStringParameters: { s, r },
    headers: origin ? { Origin: origin } : {},
  });
  const msg = (cid, body) => h({
    requestContext: { routeKey: '$default', connectionId: cid },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const bye = (cid) => h({ requestContext: { routeKey: '$disconnect', connectionId: cid } });
  return { rows, sent, gone, connect, msg, bye };
}

test('origin allow list', () => {
  assert.ok(originAllowed('https://elettro.com'));
  assert.ok(originAllowed('http://localhost:8915'));
  assert.ok(originAllowed(undefined));
  assert.ok(!originAllowed('https://evil.example'));
});

test('rejects bad session ids, roles and origins', async () => {
  const r = rig();
  assert.equal((await r.connect('a', 'x', 'display')).statusCode, 400);
  assert.equal((await r.connect('a', 'abcd1234', 'tv')).statusCode, 400);
  assert.equal((await r.connect('a', 'abcd1234', 'display', 'https://evil.example')).statusCode, 403);
  assert.equal(r.rows.size, 0);
});

test('phone joining tells the display; messages flow both ways', async () => {
  const r = rig();
  await r.connect('D1', 'abcd1234', 'display', 'https://elettro.com');
  await r.connect('P1', 'abcd1234', 'phone', 'https://elettro.com');
  assert.deepEqual(r.sent.at(-1), { cid: 'D1', data: { t: '_join' } });

  await r.msg('P1', { t: 'p', v: 0.5 });
  assert.deepEqual(r.sent.at(-1), { cid: 'D1', data: { t: 'p', v: 0.5 } });
  await r.msg('D1', { t: 'meta', max: 9000 });
  assert.deepEqual(r.sent.at(-1), { cid: 'P1', data: { t: 'meta', max: 9000 } });
});

test('sessions are isolated', async () => {
  const r = rig();
  await r.connect('D1', 'aaaa1111', 'display');
  await r.connect('D2', 'bbbb2222', 'display');
  await r.connect('P2', 'bbbb2222', 'phone');
  r.sent.length = 0;
  await r.msg('P2', { t: 'p', v: 1 });
  assert.deepEqual(r.sent.map((s) => s.cid), ['D2']);
});

test('the newest phone wins: the older one is told, and only the new one controls the screen', async () => {
  const r = rig();
  await r.connect('D1', 'abcd1234', 'display');
  await r.connect('P1', 'abcd1234', 'phone');
  r.sent.length = 0;
  await r.connect('P2', 'abcd1234', 'phone');
  assert.deepEqual(r.sent.find((s) => s.cid === 'P1'), { cid: 'P1', data: { t: 'busy' } });
  r.sent.length = 0;
  await r.msg('P1', { t: 'p', v: 0.9 }); // the replaced phone's messages go nowhere
  assert.equal(r.sent.length, 0);
  await r.msg('P2', { t: 'p', v: 0.1 });
  assert.deepEqual(r.sent.at(-1), { cid: 'D1', data: { t: 'p', v: 0.1 } });
});

test('a reloaded display replaces the old one and still finds the waiting phone', async () => {
  const r = rig();
  await r.connect('D1', 'abcd1234', 'display');
  await r.connect('P1', 'abcd1234', 'phone');
  await r.bye('D1');
  assert.deepEqual(r.sent.at(-1), { cid: 'P1', data: { t: '_leave', role: 'display' } });
  r.sent.length = 0;
  await r.connect('D2', 'abcd1234', 'display');
  assert.deepEqual(r.sent, []); // nothing can be pushed during $connect
  await r.msg('D2', { t: '_hi' });
  assert.deepEqual(r.sent, [{ cid: 'D2', data: { t: '_join' } }]);
  await r.msg('P1', { t: 'p', v: 0.3 });
  assert.deepEqual(r.sent.at(-1), { cid: 'D2', data: { t: 'p', v: 0.3 } });
});

test('disconnect cleans up and tells the other side', async () => {
  const r = rig();
  await r.connect('D1', 'abcd1234', 'display');
  await r.connect('P1', 'abcd1234', 'phone');
  r.sent.length = 0;
  await r.bye('P1');
  assert.deepEqual(r.sent, [{ cid: 'D1', data: { t: '_leave', role: 'phone' } }]);
  assert.ok(![...r.rows.keys()].some((k) => k.includes('P1')));
});

test('a vanished peer (410) is dropped instead of failing the sender', async () => {
  const r = rig();
  await r.connect('D1', 'abcd1234', 'display');
  await r.connect('P1', 'abcd1234', 'phone');
  r.gone.add('D1');
  const res = await r.msg('P1', { t: 'p', v: 0.2 });
  assert.equal(res.statusCode, 200);
  assert.ok(![...r.rows.keys()].some((k) => k.includes('D1')));
});

test('oversized and unknown-connection messages are ignored', async () => {
  const r = rig();
  await r.connect('D1', 'abcd1234', 'display');
  await r.connect('P1', 'abcd1234', 'phone');
  r.sent.length = 0;
  await r.msg('P1', 'x'.repeat(9000));
  await r.msg('NOPE', { t: 'p', v: 1 });
  assert.equal(r.sent.length, 0);
});
