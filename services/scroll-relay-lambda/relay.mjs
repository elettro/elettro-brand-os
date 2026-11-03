// Scroll relay: the message switchboard behind elettro.com/scroll (the phone-remote demo).
// A big screen ("display") and one phone share a short session id. This Lambda sits behind an API Gateway
// WebSocket API and forwards every message from one side to the other. It stores nothing but who is
// connected, and it never looks inside a message.
//
// No Postgres, no Elettro OS data, no secrets: it is fully separate from the Publishing Engine.
//
// Table layout (one DynamoDB table, pk + sk, TTL on `ttl`):
//   pk "s#<sid>"  sk "<connectionId>"  -> { role }          (who is in a session; queried to find peers)
//   pk "c#<cid>"  sk "-"                -> { sid, role }     (which session a connection belongs to)

const ROLES = new Set(['display', 'phone']);
const SID_RE = /^[a-z0-9]{4,32}$/;
const MAX_BODY = 8 * 1024;
const TTL_SECONDS = 3 * 60 * 60; // API Gateway ends a WebSocket after 2 hours anyway

const DEFAULT_ORIGINS = ['https://elettro.com', 'https://www.elettro.com'];
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function originAllowed(origin, extra = []) {
  if (!origin) return true; // non-browser clients (tests, curl) send none; the session id is the only secret anyway
  if (DEFAULT_ORIGINS.includes(origin) || extra.includes(origin)) return true;
  return LOCAL_ORIGIN_RE.test(origin);
}

function header(event, name) {
  const h = event.headers || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

/**
 * @param {{ db: { put(item):Promise, get(key):Promise<any>, query(pk):Promise<any[]>, del(key):Promise },
 *           post(connectionId:string, data:string):Promise<void>,   // throws an error with statusCode 410 when the peer is gone
 *           now?():number, extraOrigins?:string[] }} deps
 */
export function makeHandler({ db, post, now = () => Date.now(), extraOrigins = [], log = (o) => console.log(JSON.stringify(o)) }) {
  const short = (c) => String(c || '').slice(-6);
  const ttl = () => Math.floor(now() / 1000) + TTL_SECONDS;

  async function send(cid, payload) {
    try {
      await post(cid, typeof payload === 'string' ? payload : JSON.stringify(payload));
      return true;
    } catch (e) {
      if (e && (e.statusCode === 410 || e.$metadata?.httpStatusCode === 410 || e.name === 'GoneException')) return false;
      throw e;
    }
  }

  async function peersOf(sid) {
    return db.query(`s#${sid}`); // [{ sk: connectionId, role }]
  }

  async function dropConnection(cid, sid, why = 'drop') {
    log({ ev: why, sid, cid: short(cid) });
    await db.del({ pk: `c#${cid}`, sk: '-' });
    if (sid) await db.del({ pk: `s#${sid}`, sk: cid });
  }

  async function onConnect(event) {
    const qs = event.queryStringParameters || {};
    const sid = String(qs.s || '').toLowerCase();
    const role = String(qs.r || '');
    if (!SID_RE.test(sid) || !ROLES.has(role)) return { statusCode: 400, body: 'bad session' };
    if (!originAllowed(header(event, 'origin'), extraOrigins)) return { statusCode: 403, body: 'origin not allowed' };

    const cid = event.requestContext.connectionId;
    const peers = await peersOf(sid);

    // a newly opened display replaces the old one (a reloaded or next page); drop its stale record
    if (role === 'display') {
      for (const p of peers.filter((x) => x.role === 'display')) await dropConnection(p.sk, sid, 'replaced-display');
    }
    // one phone at a time, and the newest one wins: a phone that slept or reloaded must never lock you out.
    // The older phone (if still connected) is told another phone took over.
    if (role === 'phone') {
      for (const p of peers.filter((x) => x.role === 'phone')) {
        await send(p.sk, { t: 'busy' });
        await dropConnection(p.sk, sid, 'replaced-phone');
      }
    }
    log({ ev: 'connect', sid, role, cid: short(cid), peers: peers.map((x) => x.role + ':' + short(x.sk)) });
    await db.put({ pk: `s#${sid}`, sk: cid, role, ttl: ttl() });
    await db.put({ pk: `c#${cid}`, sk: '-', sid, role, ttl: ttl() });

    // tell the display a phone arrived (the display treats this as "connection open")
    if (role === 'phone') {
      for (const d of peers.filter((x) => x.role === 'display')) {
        if (!(await send(d.sk, { t: '_join' }))) await dropConnection(d.sk, sid, 'gone-on-join');
      }
    }
    return { statusCode: 200, body: 'ok' };
  }

  async function onDisconnect(event) {
    const cid = event.requestContext.connectionId;
    const me = await db.get({ pk: `c#${cid}`, sk: '-' });
    if (!me) { log({ ev: 'disconnect-unknown', cid: short(cid) }); return { statusCode: 200, body: 'ok' }; }
    log({ ev: 'disconnect', sid: me.sid, role: me.role, cid: short(cid) });
    await dropConnection(cid, me.sid, 'disconnect-row');
    const peers = await peersOf(me.sid);
    const wantRole = me.role === 'phone' ? 'display' : 'phone';
    for (const p of peers.filter((x) => x.role === wantRole)) {
      if (!(await send(p.sk, { t: '_leave', role: me.role }))) await dropConnection(p.sk, me.sid, 'gone-on-leave');
    }
    return { statusCode: 200, body: 'ok' };
  }

  async function onMessage(event) {
    const body = typeof event.body === 'string' ? event.body : '';
    if (!body || body.length > MAX_BODY) return { statusCode: 200, body: 'ignored' };
    const cid = event.requestContext.connectionId;
    const me = await db.get({ pk: `c#${cid}`, sk: '-' });
    if (!me) { log({ ev: 'msg-from-unknown', cid: short(cid) }); return { statusCode: 200, body: 'ignored' }; }
    const peers = await peersOf(me.sid);

    // A display announces itself once its socket is open (API Gateway cannot push during $connect).
    // If a phone is already waiting (the screen just moved to the next page), tell it so.
    if (me.role === 'display' && body.length < 40 && body.includes('"_hi"')) {
      if (peers.some((x) => x.role === 'phone')) await send(cid, { t: '_join' });
      return { statusCode: 200, body: 'hi' };
    }
    const wantRole = me.role === 'phone' ? 'display' : 'phone';
    const targets = peers.filter((x) => x.role === wantRole && x.sk !== cid);
    if (!targets.length) log({ ev: 'no-peer', sid: me.sid, from: me.role, cid: short(cid) });
    for (const p of targets) {
      if (!(await send(p.sk, body))) await dropConnection(p.sk, me.sid, 'gone-on-forward');
    }
    return { statusCode: 200, body: 'ok' };
  }

  return async function handler(event) {
    const route = event.requestContext?.routeKey;
    if (route === '$connect') return onConnect(event);
    if (route === '$disconnect') return onDisconnect(event);
    return onMessage(event);
  };
}
