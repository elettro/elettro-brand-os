import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { timingSafeEqual } from 'node:crypto';

const secrets = new SecretsManagerClient({});
const ROOTS = Object.fromEntries(['stashbox','solarmeister','weightlossdavie','neckermann-strom','therasbox','elettro','pianomusicsoothing','reggaeland'].map(k => [k, `/1---elettro-brand-os/brands/${k}`]));
const MAX_CHUNK = 2 * 1024 * 1024;
const MAX_SIZE = 10 * 1024 * 1024 * 1024;
const response = (statusCode, payload) => ({ statusCode, headers: {'content-type':'application/json','cache-control':'no-store'}, body:JSON.stringify(payload) });
const fail = (code, message) => response(code, {ok:false, error:message});

function requireKey(event) {
  const expected = process.env.UPLOAD_API_SHARED_SECRET || '';
  const provided = event.headers?.['x-elettro-upload-key'] || event.headers?.['X-Elettro-Upload-Key'] || '';
  const a = Buffer.from(expected, 'utf8'), b = Buffer.from(String(provided), 'utf8');
  return a.length >= 32 && b.length === a.length && timingSafeEqual(a,b);
}
function getPath(body) {
  const root = ROOTS[String(body.brand || '')];
  const folder = String(body.path || '').replace(/\\/g,'/').replace(/\/+$/,'');
  const filename = String(body.filename || '');
  if (!root || (folder.toLowerCase() !== root.toLowerCase() && !folder.toLowerCase().startsWith(root.toLowerCase() + '/'))) throw new Error('Folder is outside selected brand root');
  if (!filename || filename === '.' || filename === '..' || filename.length > 180 || /[\\/\x00-\x1f]/.test(filename)) throw new Error('Invalid filename');
  if (folder.split('/').some(segment => segment === '..' || segment === '.') || /[\x00-\x1f]/.test(folder)) throw new Error('Invalid folder');
  return folder + '/' + filename;
}
async function accessToken() {
  const secret = await secrets.send(new GetSecretValueCommand({SecretId:process.env.DROPBOX_SECRET_NAME || 'elettro-brand-os-dev/dropbox'}));
  const config = JSON.parse(secret.SecretString || '{}');
  const refresh = config.refresh_token || config.refreshToken;
  const key = config.app_key || config.appKey;
  const appSecret = config.app_secret || config.appSecret;
  if (!refresh || !key || !appSecret) throw new Error('Dropbox OAuth refresh configuration is incomplete');
  const req = await fetch('https://api.dropboxapi.com/oauth2/token', {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refresh,client_id:key,client_secret:appSecret}),signal:AbortSignal.timeout(20000)});
  if (!req.ok) throw new Error('Dropbox refresh failed with HTTP '+ req.status);
  const refreshed = await req.json();
  if (!refreshed.access_token) throw new Error('Dropbox refresh response contained no access_token');
  return refreshed.access_token;
}
async function callDropbox(endpoint, token, args, chunk) {
  const r = await fetch(`https://content.dropboxapi.com/2/files/upload_session/${endpoint}`, {method:'POST', headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream','dropbox-api-arg':JSON.stringify(args)},body:chunk,signal:AbortSignal.timeout(120000)});
  if (!r.ok) {
    const details = (await r.text()).slice(0,300).replace(/Bearer\s+\S+/g,'Bearer [REDACTED]');
    throw new Error(`Dropbox ${endpoint} returned HTTP ${r.status}: ${details}`);
  }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : {};
}
export async function handler(event = {}) {
  if (!requireKey(event)) return fail(401,'Unauthorized');
  let body;
  try { body = typeof event.body === 'string' ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : (event.body || {}); }
  catch { return fail(400,'Invalid JSON request'); }
  const action = body.action;
  if (!['start-dropbox-upload-session','append-dropbox-upload-session','finish-dropbox-upload-session'].includes(action)) return fail(400,'Unknown upload action');
  let path;
  try {path = getPath(body);} catch(e) {return fail(400,e.message);}
  const size = Number(body.size), offset=Number(body.offset || 0), b64=String(body.chunkBase64 || '');
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SIZE) return fail(400,'Invalid upload size');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) return fail(400,'Invalid upload offset');
  if (!b64 || b64.length > Math.ceil(MAX_CHUNK / 3)*4+4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return fail(400,'Invalid base64 chunk');
  const bytes=Buffer.from(b64,'base64');
  if (!bytes.length || bytes.length > MAX_CHUNK || bytes.length+offset>size) return fail(400,'Chunk out of bounds');
  const last = offset+bytes.length===size;
  if (action==='start-dropbox-upload-session' && (offset!==0 || last)) return fail(400,'Start must be a non-final first chunk');
  if (action==='append-dropbox-upload-session' && last) return fail(400,'Final chunk requires finish action');
  if (action==='finish-dropbox-upload-session' && !last) return fail(400,'Finish action requires final chunk');
  const sessionId=String(body.sessionId||'');
  if (action!=='start-dropbox-upload-session' && (!sessionId || sessionId.length > 500 || /[\x00-\x1f\x7f]/.test(sessionId))) return fail(400,'Invalid session ID');
  try {
    const token=await accessToken();
    if(action==='start-dropbox-upload-session') {
      const started=await callDropbox('start',token,{close:false},bytes);
      return response(200,{ok:true,sessionId:started.session_id,offset:bytes.length,path});
    }
    const cursor={session_id:sessionId,offset};
    if(action==='append-dropbox-upload-session') {
      await callDropbox('append_v2',token,{cursor,close:false},bytes);
      return response(200,{ok:true,sessionId,offset:offset+bytes.length,path});
    }
    const completed=await callDropbox('finish',token,{cursor,commit:{path,mode:'add',autorename:false,mute:false,strict_conflict:true}},bytes);
    return response(200,{ok:true,complete:true,offset:size,path:completed.path_display||path,dropboxFileId:completed.id});
  } catch(error) {
    console.error('Dropbox upload session failed:',error?.message || 'Unknown error');
    return fail(502, error?.message || 'Dropbox upload failed');
  }
}
