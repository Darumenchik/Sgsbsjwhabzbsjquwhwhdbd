/* ========== CHIPER DATA LAYER v3 ==========
   - Profile / settings / meta → localStorage
   - Chats metadata + messages (without heavy blobs) → IndexedDB
   - Media blobs (voice / image / file) → IndexedDB (separate store)
   - Schema versioning + migration
   - Export / Import
*/
const META_KEY = 'chiper_meta_v3';
const ACCOUNTS_KEY = 'chiper_accounts_v1';
const DB_NAME = 'chiper_db';
const DB_VERSION = 2;
const SCHEMA_VERSION = 3;
const NETLIFY_FUNCTIONS_BASE = '/api';
const E2EE_PRIVATE_KEY_STORAGE = 'chiper_e2ee_private_key';
const E2EE_PUBLIC_KEY_STORAGE = 'chiper_e2ee_public_key';

function getFunctionUrl(name){
  return `${NETLIFY_FUNCTIONS_BASE}/${name}`;
}
function base64Encode(arrayBuffer){
  const bytes = new Uint8Array(arrayBuffer);
  let str = '';
  for(let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str);
}
function base64Decode(value){
  const bin = atob(value);
  const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function utf8Encode(value){ return new TextEncoder().encode(String(value)); }
function utf8Decode(buffer){ return new TextDecoder().decode(buffer); }

async function fetchJson(url, options = {}){
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  // Prefer pending registration/auth email (onboarding flow) so JWT is attached before state.profile is set
  let targetEmail = (window._pendingReg && window._pendingReg.email) || (window._pendingAuth && window._pendingAuth.email) || null;
  if (!targetEmail) {
    try { targetEmail = state.profile && state.profile.email; } catch(e) {}
  }
  if (targetEmail) {
    const accs = loadAccounts();
    const tk = accs[String(targetEmail).toLowerCase()]?.token;
    if (tk) headers['Authorization'] = 'Bearer ' + tk;
  }
  const response = await fetch(url, {
    ...options,
    headers
  });
  const text = await response.text();
  let data = {};
  try{ data = text ? JSON.parse(text) : {}; }catch(_){ }
  if(!response.ok) {
    if (response.status === 401 && typeof state !== 'undefined' && state.loggedIn) {
      state.loggedIn = false;
      document.body.classList.remove('authed');
      if (typeof go === 'function') go('login');
      if (typeof showToast === 'function') showToast('Сессия истекла. Войдите снова.');
    }
    throw new Error(data.error || data.message || `Ошибка ${response.status}`);
  }
  return data;
}
async function postJson(url, body){ return fetchJson(url, { method: 'POST', body: JSON.stringify(body) }); }
async function getJson(url){ return fetchJson(url, { method: 'GET' }); }
async function patchJson(url, body){ return fetchJson(url, { method: 'PATCH', body: JSON.stringify(body) }); }

async function requestOtp(email){ return postJson(getFunctionUrl('send-otp'), { email }); }
async function verifyOtp(email, code){
  const result = await postJson(getFunctionUrl('verify-otp'), { email, code });
  if (result && result.token) {
    const accounts = loadAccounts();
    const em = String(email || '').trim().toLowerCase();
    if (em) {
      if (!accounts[em]) accounts[em] = {};
      accounts[em].token = result.token;
      saveAccounts(accounts);
    }
  }
  return result;
}
async function loadProfileByEmail(email){
  if(!email) return null;
  const data = await getJson(getFunctionUrl('get-profile') + '?email=' + encodeURIComponent(email.toLowerCase()));
  return data.profile || null;
}
async function loadProfileFromUsername(username){
  if(!username) return null;
  const normalized = normalizeUsername(username);
  const data = await getJson(getFunctionUrl('get-profile') + '?username=' + encodeURIComponent(normalized));
  return data.profile || null;
}
async function saveProfileToServer(profile){
  if(!profile || !profile.email || !profile.username) return null;
  const payload = {
    email: String(profile.email).trim().toLowerCase(),
    username: normalizeUsername(profile.username),
    updated_at: new Date().toISOString(),
  };
  if(profile.name !== undefined) payload.name = String(profile.name || null);
  if(profile.bio !== undefined) payload.bio = String(profile.bio || null);
  if(profile.avatar !== undefined) payload.avatar = profile.avatar || null;
  if(profile.avatarType !== undefined) payload.avatar_type = String(profile.avatarType || profile.avatar_type || null);
  if(profile.birthday !== undefined) payload.birthday = String(profile.birthday || null);
  if(profile.city !== undefined) payload.city = String(profile.city || null);
  if(profile.phone !== undefined) payload.phone = String(profile.phone || null);
  if(profile.website !== undefined) payload.website = String(profile.website || null);
  if(profile.coins !== undefined) payload.coins = Number(profile.coins) || 0;
  if(profile.stars !== undefined) payload.stars = Number(profile.stars) || 0;
  if(profile.verified !== undefined) payload.verified = !!profile.verified;
  if(profile.premium !== undefined) payload.premium = !!profile.premium;
  if(profile.public_key !== undefined) payload.public_key = profile.public_key;
  if(profile.publicKey !== undefined && !payload.public_key) payload.public_key = profile.publicKey;
  return postJson(getFunctionUrl('save-profile'), payload);
}
async function saveEncryptedMessageToServer(message){
  return postJson(getFunctionUrl('save-message'), message);
}
async function fetchRemoteMessages(chatId){
  const username = state.profile?.username;
  if(!username || !chatId) return [];
  const data = await getJson(getFunctionUrl('get-messages') + '?email=' + encodeURIComponent((state.profile?.email || '').toLowerCase()) + '&chat_id=' + encodeURIComponent(chatId));
  return data.messages || [];
}

async function getE2EEPrivateKey(){
  const raw = localStorage.getItem(E2EE_PRIVATE_KEY_STORAGE);
  if(!raw) return null;
  try{
    return await window.crypto.subtle.importKey('raw', base64Decode(raw), { name: 'X25519', namedCurve: 'X25519' }, true, ['deriveKey']);
  }catch(e){ console.warn('import private key failed', e); return null; }
}
async function getE2EEPublicKey(){
  const raw = localStorage.getItem(E2EE_PUBLIC_KEY_STORAGE);
  if(!raw) return null;
  try{
    return await window.crypto.subtle.importKey('raw', base64Decode(raw), { name: 'X25519', namedCurve: 'X25519' }, true, []);
  }catch(e){ console.warn('import public key failed', e); return null; }
}
async function saveE2EEKeyPair(privateKey, publicKey){
  const rawPrivate = await window.crypto.subtle.exportKey('raw', privateKey);
  const rawPublic = await window.crypto.subtle.exportKey('raw', publicKey);
  localStorage.setItem(E2EE_PRIVATE_KEY_STORAGE, base64Encode(rawPrivate));
  localStorage.setItem(E2EE_PUBLIC_KEY_STORAGE, base64Encode(rawPublic));
}
async function generateE2EEKeyPair(){
  const keys = await window.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'X25519' }, true, ['deriveKey']);
  await saveE2EEKeyPair(keys.privateKey, keys.publicKey);
  return keys;
}
async function ensureE2EEKeyPair(){
  let privateKey = await getE2EEPrivateKey();
  let publicKey = await getE2EEPublicKey();
  if(privateKey && publicKey) return { privateKey, publicKey };
  return generateE2EEKeyPair();
}
async function exportPublicKeyBase64(publicKey){
  const raw = await window.crypto.subtle.exportKey('raw', publicKey);
  return base64Encode(raw);
}
async function importPublicKeyBase64(value){
  return window.crypto.subtle.importKey('raw', base64Decode(value), { name: 'X25519', namedCurve: 'X25519' }, true, []);
}
async function deriveChatKey(peerPublicKey, saltBytes){
  const privateKey = await getE2EEPrivateKey();
  if(!privateKey) throw new Error('E2EE ключ не найден');
  return window.crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: utf8Encode('Chiper E2EE v1') },
    false,
    ['encrypt', 'decrypt']
  );
}
async function encryptChatPayload(peerPublicKey, payload){
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveChatKey(peerPublicKey, salt);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const text = utf8Encode(JSON.stringify(payload));
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8Encode(payload.id + payload.chat_id) },
    key,
    text
  );
  return {
    ciphertext: base64Encode(ciphertext),
    iv: base64Encode(iv),
    salt: base64Encode(salt),
  };
}
async function decryptChatPayload(record, peerPublicKey){
  const salt = new Uint8Array(base64Decode(record.salt));
  const key = await deriveChatKey(peerPublicKey, salt);
  const iv = new Uint8Array(base64Decode(record.iv));
  const plain = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: utf8Encode(record.id + record.chat_id) },
    key,
    base64Decode(record.ciphertext)
  );
  return JSON.parse(utf8Decode(plain));
}
async function getPeerPublicKey(peerUsername){
  if(!peerUsername) return null;
  const key = normalizeUsername(peerUsername).toLowerCase();
  const cached = state.usersIndex[key] || state.usersIndex[key.replace(/^@/,'')];
  if(cached?.public_key){ return importPublicKeyBase64(cached.public_key); }
  const profile = await loadProfileFromUsername(peerUsername);
  if(!profile) return null;
  if(profile.username){ state.usersIndex[profile.username.toLowerCase()] = profile; }
  if(profile.email){ state.usersIndex[profile.email.toLowerCase()] = profile; }
  return profile.public_key ? importPublicKeyBase64(profile.public_key) : null;
}
async function prepareCurrentUserProfile(){
  const keys = await ensureE2EEKeyPair();
  const publicKey = await exportPublicKeyBase64(keys.publicKey);
  if(!state.profile) state.profile = {};
  state.profile.public_key = publicKey;
  if(state.profile.email){
    try{ await saveProfileToServer({ ...state.profile, public_key: publicKey }); }catch(_){ }
  }
  return publicKey;
}
async function loadRemoteChatMessages(chatId){
  const chat = state.chats[chatId];
  if(!chat || chat.isGroup || chat.isChannel || !chat.contactId) return;
  const remote = await fetchRemoteMessages(chatId);
  const peer = peerFromDmId(chatId);
  const peerPublicKey = await getPeerPublicKey(peer);
  if(!peerPublicKey) return;
  for(const record of remote){
    if(chat.messages.some(m => m.id === record.id)) continue;
    try{
      const payload = await decryptChatPayload(record, peerPublicKey);
      if(payload.id !== record.id || payload.chat_id !== record.chat_id) throw new Error('Payload mismatch');
      const msg = {
        ...payload,
        status: 'sent',
        from: normalizeUsername(record.sender_username),
        out: normalizeUsername(record.sender_username) === normalizeUsername(state.profile.username),
      };
      chat.messages.push(msg);
    }catch(e){ console.warn('decrypt message', e); }
  }
  chat.messages.sort((a,b)=>(a.ts||0)-(b.ts||0));
  if(chat.messages.length){ chat.lastTs = chat.messages[chat.messages.length-1].ts || Date.now(); }
  try{ await persistChatMeta(chatId); }catch(_){ }
}

async function loadConversationMessages(conversationId){
  const chat = state.chats[conversationId];
  if(!chat) return;
  try{
    const res = await getJson(`/api/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=100`);
    const messages = Array.isArray(res.messages) ? res.messages : [];
    for(const record of messages){
      if(chat.messages.some(m => m.id === record.id)) continue;
      const msg = {
        id: record.id,
        type: record.message_type || 'text',
        text: record.content || '',
        from: record.sender_id,
        out: record.sender_id === state.profile?.id,
        ts: new Date(record.created_at).getTime(),
        status: 'sent',
        replyTo: null,
      };
      chat.messages.push(msg);
    }
    chat.messages.sort((a,b)=>(a.ts||0)-(b.ts||0));
    if(chat.messages.length){ chat.lastTs = chat.messages[chat.messages.length-1].ts || Date.now(); }
    try{ await persistChatMeta(conversationId); }catch(_){ }
  }catch(e){
    console.error('Load conversation messages error:', e);
  }
}
async function encryptAndSendMessage(chatId, msg){
  const peerUsername = normalizeUsername(peerFromDmId(chatId));
  const peerPublicKey = await getPeerPublicKey(peerUsername);
  if(!peerPublicKey) throw new Error('Публичный ключ получателя не найден');
  const keys = await ensureE2EEKeyPair();
  const senderPublicKey = await exportPublicKeyBase64(keys.publicKey);
  const payload = {
    id: msg.id,
    chat_id: chatId,
    sender_username: normalizeUsername(state.profile.username),
    recipient_username: peerUsername,
    type: msg.type || 'text',
    text: msg.text || '',
    ts: msg.ts,
    replyTo: msg.replyTo || null,
  };
  const encrypted = await encryptChatPayload(peerPublicKey, payload);
  await saveEncryptedMessageToServer({
    id: msg.id,
    chat_id: chatId,
    sender_username: normalizeUsername(state.profile.username),
    recipient_username: peerUsername,
    sender_public_key: senderPublicKey,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    salt: encrypted.salt,
    metadata: { type: payload.type, ts: payload.ts, replyTo: payload.replyTo },
  });
}

/* ========== SUPABASE (optional cloud sync) ==========
   Чтобы включить: создайте проект на https://supabase.com,
   вставьте URL и anon key ниже. Без ключей работает локально (IndexedDB).
   SQL-схема (выполнить в SQL Editor):
   create table profiles (id uuid primary key default gen_random_uuid(), email text unique not null, username text unique, name text, bio text, avatar text, avatar_type text, coins integer default 0, stars integer default 0, verified boolean default false, premium boolean default false, public_key text, created_at timestamptz default now(), updated_at timestamptz default now());
   create table otp_verifications (id uuid primary key default gen_random_uuid(), email text not null, code_hash text not null, expires_at timestamptz not null, used boolean default false, created_at timestamptz default now());
   create table e2ee_messages (id text primary key, chat_id text not null, sender_username text not null, recipient_username text not null, ciphertext text not null, iv text not null, salt text not null, sender_public_key text not null, metadata jsonb, created_at timestamptz default now());
   alter table public.profiles enable row level security;
   alter table public.otp_verifications enable row level security;
   alter table public.e2ee_messages enable row level security;
*/

/* ========== LOCAL DATA LAYER (no cloud) ========== */
const FIREBASE_CONFIG = null; // disabled
let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;
let firebaseStorage = null;
let firebaseAnalytics = null;

function initFirebase(){ return null; }
async function ensureFirestoreOnline(){ return false; }
function fs(){ return null; }

async function firebaseSignInEmail(){ throw new Error('Cloud disabled'); }
async function firebaseRegisterEmail(){ throw new Error('Cloud disabled'); }
async function syncProfileToFirestore(){ /* local only */ }
async function loadProfileFromFirestore(){ return null; }
async function fsGetUser(){ return null; }
function stripHeavyProfileFields(p){ return p || {}; }
function buildCloudUserPayload(p){ return p || {}; }
async function fsSaveUser(){ /* no-op */ }
async function writeOnce(){ /* no-op */ }
async function fsSaveSettings(){ /* no-op */ }
async function fsIsUsernameTaken(username, exceptUid){
  // local check against accounts
  const un = normalizeUsername(username);
  const accounts = loadAccounts();
  for(const [email, a] of Object.entries(accounts)){
    const pu = normalizeUsername(a.profile?.username || '');
    const uid = a.profile?.uid || email;
    if(pu === un && uid !== exceptUid && email !== exceptUid) return true;
  }
  return false;
}
async function fsUploadDataUrl(dataUrl){ return dataUrl; }
async function fsUploadBlob(){ return null; }
async function onFirebaseUser(){ /* no-op local mode */ }
async function loadChatsFromFirestore(){ /* no-op */ }
async function loadOneChat(){ /* no-op */ }
function subscribeFirestore(){ /* no-op */ }

/* Local meta + accounts live in localStorage; chats in IndexedDB (see below) */
function saveMeta(){
  try{
    const payload = {
      schema: SCHEMA_VERSION,
      profile: state.profile || {},
      settings: state.settings || {},
      drafts: state.drafts || {},
      coinTx: state.coinTx || [],
      loggedIn: !!state.loggedIn,
      sessionEmail: state.profile?.email || null,
    };
    localStorage.setItem(META_KEY, JSON.stringify(payload));
  }catch(e){ console.warn('saveMeta', e); }
}
function loadMeta(){
  try{
    const raw = localStorage.getItem(META_KEY);
    if(!raw) return SCHEMA_VERSION;
    const data = JSON.parse(raw);
    if(data.profile) state.profile = Object.assign(state.profile || {}, data.profile);
    if(data.settings) state.settings = Object.assign(state.settings || {}, data.settings);
    if(data.drafts) state.drafts = data.drafts;
    if(Array.isArray(data.coinTx)) state.coinTx = data.coinTx;
    state.loggedIn = !!data.loggedIn;
    if(data.sessionEmail && !state.profile?.email){
      state.profile = state.profile || {};
      state.profile.email = data.sessionEmail;
    }
    return data.schema || SCHEMA_VERSION;
  }catch(e){
    try{
      const data = JSON.parse(localStorage.getItem(META_KEY) || '{}');
      if(data.profile) state.profile = Object.assign(state.profile || {}, data.profile);
      if(data.settings) state.settings = Object.assign(state.settings || {}, data.settings);
      if(data.drafts) state.drafts = data.drafts;
      if(Array.isArray(data.coinTx)) state.coinTx = data.coinTx;
      state.loggedIn = !!data.loggedIn;
      if(data.sessionEmail && !state.profile?.email){
        state.profile = state.profile || {};
        state.profile.email = data.sessionEmail;
      }
      return data.schema || SCHEMA_VERSION;
    }catch(_){ return SCHEMA_VERSION; }
  }
}
function loadAccounts(){
  try{
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if(!raw) return {};
    return raw ? JSON.parse(raw) : {};
  }catch(_){
    try{ return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '{}'); }catch(__){ return {}; }
  }
}
function saveAccounts(acc){
  try{ localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(acc || {})); }
  catch(e){ console.warn('saveAccounts', e); }
}
async function persistProfileToAccounts(){
  try{
    const accounts = loadAccounts();
    const email = (state.profile?.email || '').toLowerCase();
    if(!email){ saveMeta(); return; }
    if(!accounts[email]) accounts[email] = { passwordHash: accounts[email]?.passwordHash };
    accounts[email].profile = { ...(accounts[email].profile || {}), ...state.profile };
    saveAccounts(accounts);
    saveMeta();
    try{ rebuildUsersIndex(); }catch(_){}
  }catch(e){ console.warn('persistProfile', e); saveMeta(); }
}

// Stubs overwritten later by IndexedDB implementations
async function persistChatMeta(chatId){ /* filled by IDB layer */ }
async function persistMessage(chatId, msg){ /* filled by IDB layer */ }
async function deleteMessageFromDB(msgId){ /* filled by IDB layer */ }
async function updateMessage(chatId, msgId, patch){
  const chat = state.chats[chatId];
  const m = chat?.messages.find(x => x.id === msgId);
  if(m) Object.assign(m, patch);
  try{
    if(db){
      const existing = await idbGet('messages', msgId);
      if(existing) await idbPut('messages', { ...existing, ...patch, id: msgId, chatId });
    }
  }catch(_){}
  if(bc) bc.postMessage({ type: 'update_message', chatId, msgId, patch });
}
async function removeMessage(chatId, msgId){
  const chat = state.chats[chatId];
  if(chat) chat.messages = chat.messages.filter(m => m.id !== msgId);
  try{ await deleteMessageFromDB(msgId); }catch(_){}
  if(bc) bc.postMessage({ type: 'delete_message', chatId, msgId });
}

function setAvatarPosition(pos){
  if(!['left','center','right'].includes(pos)) pos = 'center';
  if(!state.profile) state.profile = {};
  state.profile.avatarPosition = pos;
  const head = document.getElementById('profileHead');
  if(head){
    head.classList.remove('avatar-left','avatar-center','avatar-right');
    head.classList.add('avatar-' + pos);
  }
  document.querySelectorAll('#avatarPosPicker .avatar-pos-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.getAttribute('data-pos') === pos);
  });
  try{ saveMeta(); }catch(_){}
  try{ persistProfileToAccounts(); }catch(_){}
  showToast(pos === 'left' ? 'Аватар слева' : pos === 'right' ? 'Аватар справа' : 'Аватар по центру');
}
function applyAvatarPosition(){
  const pos = (state.profile && state.profile.avatarPosition) || 'center';
  const head = document.getElementById('profileHead');
  if(head){
    head.classList.remove('avatar-left','avatar-center','avatar-right');
    head.classList.add('avatar-' + pos);
  }
  document.querySelectorAll('#avatarPosPicker .avatar-pos-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.getAttribute('data-pos') === pos);
  });
}
function shareProfile(){
  const u = (state.profile && state.profile.username) || '@user';
  const link = location.origin + location.pathname + '#u/' + encodeURIComponent(u.replace(/^@/,''));
  if(navigator.share){
    navigator.share({ title: 'Chiper', text: 'Мой профиль в Chiper: ' + u, url: link }).catch(()=>{});
  } else if(navigator.clipboard){
    navigator.clipboard.writeText(link).then(()=>showToast('Ссылка скопирована'));
  } else {
    prompt('Ссылка на профиль:', link);
  }
}


let db = null;
let state = {
  profile: {
    name: 'Пользователь',
    username: '@user',
    bio: 'Привет! Я в Chiper 👋',
    avatar: null,
    avatarType: null, // 'image' | 'video'
    banner: null
  },
  settings: {
    theme: 'system',
    accent: 'blue',
    privacy: false,
    notifications: true
  },
  chats: {},
  currentChatId: null,
  replyTo: null,
  loggedIn: false,
  onlineStatus: {},
  usersIndex: {}, // username → profile (from local accounts + created chats)
  drafts: {},
  coinTx: [],
  selectMode: false,
  selectedMsgs: new Set(),
  searchHits: [],
  searchHitIdx: -1,
  readBoundaryId: null, // message id after which "read up to here" was shown
};

function uid(){ return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function getContact(id){
  // Prefer live chat meta, then usersIndex, then synthetic
  const chat = state.chats[id];
  if(chat && chat.title){
    return {
      id,
      name: chat.title,
      username: chat.handle || ('@'+id),
      initials: (chat.title||'??').slice(0,2).toUpperCase(),
      gradient: chat.isChannel ? 'av-g4' : chat.isGroup ? 'av-g3' : 'av-g1',
      online: !!(state.onlineStatus[id]?.online),
      bio: chat.bio || '',
      isGroup: !!chat.isGroup,
      isChannel: !!chat.isChannel,
    };
  }
  // DM: resolve peer username from canonical id
  let lookup = id;
  if(String(id).startsWith('dm_')){
    lookup = peerFromDmId(id);
  } else if(chat && chat.contactId){
    lookup = chat.contactId;
  }
  const u = state.usersIndex[lookup] || state.usersIndex[String(lookup).replace(/^@/,'')] ||
    Object.values(state.usersIndex).find(x => x.id === lookup || x.username === lookup || x.username === '@'+lookup);
  if(u){
    return {
      id: u.id || lookup,
      name: u.name || lookup,
      username: u.username || ('@'+lookup),
      initials: (u.name||lookup||'??').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase(),
      gradient: u.gradient || 'av-g1',
      online: !!(state.onlineStatus[u.id||lookup]?.online),
      bio: u.bio || '',
    };
  }
  const clean = String(lookup||id||'').replace(/^@/,'');
  return {
    id: clean,
    name: clean,
    initials: clean.slice(0,2).toUpperCase() || '??',
    gradient: 'av-g1',
    online: false,
    username: '@'+clean,
    bio: ''
  };
}

function rebuildUsersIndex(){
  state.usersIndex = {};
  // from local accounts
  try{
    const acc = loadAccounts();
    Object.entries(acc).forEach(([email, a])=>{
      if(!a.profile) return;
      const un = (a.profile.username||'').toLowerCase();
      const id = un.replace(/^@/,'') || email;
      state.usersIndex[id] = {
        id,
        name: a.profile.name,
        username: a.profile.username,
        bio: a.profile.bio,
        email,
        avatar: a.profile.avatar,
        gradient: 'av-g2',
      };
      if(un) state.usersIndex[un] = state.usersIndex[id];
    });
  }catch(_){}
  // from existing chats
  Object.entries(state.chats).forEach(([id, chat])=>{
    if(chat.isGroup || chat.isChannel) return;
    const c = chat.contactId || id;
    if(!state.usersIndex[c]){
      state.usersIndex[c] = { id:c, name:c, username:'@'+c, bio:'', gradient:'av-g1' };
    }
  });
}

/* ---------- IndexedDB ---------- */
function openDB(){
  if(db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      console.warn('indexedDB unavailable', e);
      reject(e);
      return;
    }
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if(!database.objectStoreNames.contains('chats')){
        const chats = database.createObjectStore('chats', { keyPath: 'id' });
        chats.createIndex('lastTs', 'lastTs');
        chats.createIndex('archived', 'archived');
        try { chats.createIndex('type', 'type'); } catch(_){}
      } else {
        try {
          const tx = e.target.transaction;
          const chats = tx.objectStore('chats');
          if (!chats.indexNames.contains('type')) chats.createIndex('type', 'type');
        } catch(_){}
      }
      if(!database.objectStoreNames.contains('messages')){
        const msgs = database.createObjectStore('messages', { keyPath: 'id' });
        msgs.createIndex('chatId', 'chatId');
        msgs.createIndex('ts', 'ts');
        try { msgs.createIndex('chatId_ts', ['chatId', 'ts']); } catch(_){}
      } else {
        try {
          const tx = e.target.transaction;
          const msgs = tx.objectStore('messages');
          if (!msgs.indexNames.contains('chatId_ts')) msgs.createIndex('chatId_ts', ['chatId', 'ts']);
        } catch(_){}
      }
      if(!database.objectStoreNames.contains('media')){
        database.createObjectStore('media', { keyPath: 'id' });
      }
      if(!database.objectStoreNames.contains('meta')){
        database.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      db = req.result;
      db.onversionchange = () => { try { db.close(); } catch(_){} db = null; };
      db.onerror = (ev) => console.warn('[idb]', ev?.target?.error);
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => console.warn('[idb] open blocked — close other tabs');
  });
}

function idbReq(storeName, mode, fn){
  return new Promise((resolve, reject) => {
    if(!db) return reject(new Error('DB not open'));
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(store, key){
  return new Promise((resolve, reject) => {
    if(!db){ resolve(undefined); return; }
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(store, indexName, query){
  return new Promise((resolve, reject) => {
    if(!db){ resolve([]); return; }
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    let req;
    if(indexName){
      const idx = os.index(indexName);
      req = (query === undefined) ? idx.getAll() : idx.getAll(query);
    } else {
      req = os.getAll();
    }
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, value){
  return new Promise((resolve, reject) => {
    if(!db){ resolve(); return; }
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(store, key){
  return new Promise((resolve, reject) => {
    if(!db){ resolve(); return; }
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClear(store){
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- Meta (localStorage) ---------- */
/* saveMeta / loadMeta / loadAccounts / saveAccounts defined in LOCAL DATA LAYER above */

async function loadAllChats(){
  try {
    if(!db) await openDB();
  } catch (e) {
    console.warn('openDB failed, using memory only', e);
    state.chats = state.chats || {};
    return;
  }
  if(!db){ state.chats = {}; return; }
  try{
    const chats = await idbGetAll('chats');
    state.chats = {};
    // Parallel load messages per chat (cap concurrent)
    const chunks = [];
    for (let i = 0; i < chats.length; i += 8) chunks.push(chats.slice(i, i + 8));
    for (const batch of chunks) {
      await Promise.all(batch.map(async (c) => {
      const id = c.id;
      let messages = [];
      try{
        messages = await idbGetAll('messages', 'chatId', id);
        messages.sort((a,b)=>(a.ts||0)-(b.ts||0));
        // keep last 500 in memory for huge chats
        if (messages.length > 500) messages = messages.slice(-500);
        // hydrate media only for last 40 messages with mediaId
        const needMedia = messages.filter(m => m.mediaId && !m.data).slice(-40);
        await Promise.all(needMedia.map(async (m) => {
          try {
            const med = await idbGet('media', m.mediaId);
            if (med && med.data) m.data = med.data;
          } catch (_) {}
        }));
      }catch(_){}
      state.chats[id] = {
        contactId: c.contactId || id,
        messages,
        unread: c.unread || 0,
        archived: !!c.archived,
        pinned: !!c.pinned,
        muted: !!c.muted,
        lastTs: c.lastTs || (messages.length ? messages[messages.length-1].ts : 0),
        title: c.title || null,
        handle: c.handle || null,
        isGroup: !!c.isGroup,
        isChannel: !!c.isChannel,
        type: c.type || (c.isChannel ? 'channel' : c.isGroup ? 'group' : 'personal'),
        bio: c.bio || null,
        members: c.members || [],
        memberUids: c.memberUids || [],
        avatar: c.avatar || null,
        subscribed: c.subscribed !== false,
        joined: c.joined !== false,
        subscribers: c.subscribers || null,
        isPublic: c.isPublic !== false,
        createdBy: c.createdBy || null,
        admins: c.admins || [],
        pinnedMsgId: c.pinnedMsgId || null,
        serverId: c.serverId || null,
      };
      })); // end Promise.all map
    } // end batch
  }catch(e){
    console.warn('loadAllChats', e);
    state.chats = state.chats || {};
  }

  // Load conversations from server
  const myPid = state.profile?.id || state.profile?.uid;
  if(myPid){
    try{
      const res = await getJson(`/api/conversations?profile_id=${encodeURIComponent(myPid)}`);
      const conversations = Array.isArray(res.conversations) ? res.conversations : [];
      for(const conv of conversations){
        const chatId = conv.id;
        if(!state.chats[chatId]){
          state.chats[chatId] = {
            contactId: chatId,
            messages: [],
            unread: 0,
            archived: !!conv.archived,
            pinned: !!conv.pinned,
            muted: !!conv.muted,
            lastTs: conv.last_message_at ? new Date(conv.last_message_at).getTime() : Date.now(),
            title: conv.name || (conv.type === 'dm' ? 'Личный чат' : 'Чат'),
            handle: null,
            isGroup: conv.type === 'group',
            isChannel: conv.type === 'channel',
            bio: conv.description || null,
            members: [],
            memberUids: [],
            avatar: conv.avatar || null,
            subscribed: true,
            joined: true,
            subscribers: null,
            isPublic: true,
            createdBy: conv.created_by || null,
            admins: [],
            pinnedMsgId: null,
            serverId: conv.id,
          };
          try { await persistChatMeta(chatId); } catch (_) {}
        } else {
          // Merge server meta into existing local chat
          if (conv.name) state.chats[chatId].title = state.chats[chatId].title || conv.name;
          state.chats[chatId].isGroup = state.chats[chatId].isGroup || conv.type === 'group';
          state.chats[chatId].isChannel = state.chats[chatId].isChannel || conv.type === 'channel';
          state.chats[chatId].serverId = conv.id;
          if (conv.archived != null) state.chats[chatId].archived = !!conv.archived;
          if (conv.pinned != null) state.chats[chatId].pinned = !!conv.pinned;
        }
      }
    }catch(e){
      console.error('Load conversations error:', e);
    }
  }
}

async function persistChatMeta(chatId){
  const chat = state.chats[chatId];
  if(!chat) return;
  if(!db){ try{ await openDB(); }catch(_){ return; } }
  if(!db) return;
  const payload = {
    id: chatId,
    contactId: chat.contactId || chatId,
    unread: chat.unread || 0,
    archived: !!chat.archived,
    pinned: !!chat.pinned,
    muted: !!chat.muted,
    lastTs: chat.lastTs || Date.now(),
    title: chat.title || null,
    handle: chat.handle || null,
    isGroup: !!chat.isGroup,
    isChannel: !!chat.isChannel,
    type: chat.type || (chat.isChannel ? 'channel' : chat.isGroup ? 'group' : 'personal'),
    bio: chat.bio || null,
    members: chat.members || [],
    memberUids: chat.memberUids || [],
    avatar: (chat.avatar && String(chat.avatar).length < 500000) ? chat.avatar : null,
    subscribed: chat.subscribed !== false,
    joined: chat.joined !== false,
    subscribers: chat.subscribers || null,
    isPublic: chat.isPublic !== false,
    createdBy: chat.createdBy || null,
    admins: chat.admins || [],
    pinnedMsgId: chat.pinnedMsgId || null,
    serverId: chat.serverId || null,
  };
  try{ await idbPut('chats', payload); }catch(e){ console.warn('persistChatMeta', e); }

  // Sync archive/pin/mute to Supabase when conversation is a real server UUID
  try {
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(chatId);
    if(looksLikeUuid && typeof patchJson === 'function'){
      await patchJson(`/api/conversations/${encodeURIComponent(chatId)}/member`, {
        archived: !!chat.archived,
        pinned: !!chat.pinned,
        muted: !!chat.muted,
      });
    }
  } catch(e){ /* offline or not yet synced — local state is enough */ }
}

async function persistMessage(chatId, msg){
  if(!db){ try{ await openDB(); }catch(_){ return; } }
  if(!db) return;
  const toStore = { ...msg, chatId };
  // store heavy media separately
  if(msg.data && (msg.type === 'voice' || msg.type === 'image' || msg.type === 'file')){
    try{
      const mediaId = 'med_' + (msg.id || uid());
      await idbPut('media', { id: mediaId, data: msg.data, type: msg.type });
      toStore.mediaId = mediaId;
      delete toStore.data; // keep memory copy on msg object for UI
    }catch(e){
      console.warn('media store', e);
      // keep data inline if media store fails (may hit quota)
    }
  }
  delete toStore.waveform;
  try{ await idbPut('messages', toStore); }catch(e){ console.warn('persistMessage', e); }
  if(state.chats[chatId]){
    state.chats[chatId].lastTs = msg.ts || Date.now();
    await persistChatMeta(chatId);
  }
}

async function deleteMessageFromDB(msgId){
  if(!db) return;
  try{
    const msg = await idbGet('messages', msgId);
    if(msg?.mediaId) await idbDelete('media', msg.mediaId);
    await idbDelete('messages', msgId);
  }catch(e){ console.warn('deleteMessageFromDB', e); }
}

async function saveState(){
  saveMeta();
  if(state.currentChatId && state.chats[state.currentChatId]){
    await persistChatMeta(state.currentChatId);
  }
}

/* ---------- Migration from v2 (localStorage) ---------- */
async function migrateFromV2(){
  return false;
}

/* ---------- Public API used by UI ---------- */
async function loadState(){
  try{ await openDB(); }catch(e){ console.warn('openDB', e); }
  loadMeta();
  applyTheme();
  applyAccent();
  applyCompact();
  applyThemeSchedule();
  try{ registerPWA(); }catch(_){}
  if(state.settings?.notifications) ensureNotifPermission().catch(()=>{});

  // Restore session from local meta
  const sessionEmail = (state.profile?.email || '').toLowerCase();
  const accounts = loadAccounts();
  if(state.loggedIn && sessionEmail){
    if(accounts[sessionEmail]?.profile?.username){
      state.profile = { ...accounts[sessionEmail].profile, email: sessionEmail };
    }
    const remoteProfile = await loadProfileByEmail(sessionEmail).catch(() => null);
    if(remoteProfile){
      state.profile = { ...state.profile, ...remoteProfile, email: sessionEmail };
      if(!state.profile.uid) state.profile.uid = state.profile.email;
      accounts[sessionEmail] = { profile: { ...(accounts[sessionEmail]?.profile || {}), ...state.profile } };
      saveAccounts(accounts);
      saveMeta();
    }
    if(state.profile?.username){
      state.loggedIn = true;
      if(!state.profile.public_key){
        await prepareCurrentUserProfile().catch(()=>{});
      }
      document.body.classList.add('authed');
      await loadAllChats();
      try{ rebuildUsersIndex(); }catch(_){ }
      go('chats');
      try{ renderChatList(); renderProfile(); updateCoinsUI(); }catch(_){ }
    } else {
      // Try silent restore if meta says logged in
    try{
      const raw = localStorage.getItem(META_KEY);
      const data = raw ? JSON.parse(raw) : null;
      if(data && data.loggedIn && data.sessionEmail && accounts[data.sessionEmail]?.profile?.username){
        state.profile = { ...accounts[data.sessionEmail].profile, email: data.sessionEmail };
        state.loggedIn = true;
        if(!state.profile.public_key){
          await prepareCurrentUserProfile().catch(()=>{});
        }
        document.body.classList.add('authed');
        await loadAllChats();
        try{ rebuildUsersIndex(); }catch(_){}
        go('chats');
        try{ renderChatList(); renderProfile(); updateCoinsUI(); }catch(_){}
        return;
      }
    }catch(_){}
    state.loggedIn = false;
    document.body.classList.remove('authed');
    state.chats = {};
    go('login');
  }
}


}
async function addMessage(chatId, msg){
  const chat = state.chats[chatId];
  if(!chat) return;
  if(!msg.id) msg.id = uid();
  if(!msg.from) msg.from = getCurrentUserKey();
  // keep msg.out as sender's view; receivers use isMessageOut()
  chat.messages.push(msg);
  chat.lastTs = msg.ts || Date.now();
  if(!isMessageOut(msg)) chat.unread = (chat.unread || 0) + 1;
  await persistMessage(chatId, msg);
  // broadcast to other tabs / other accounts
  if(bc) bc.postMessage({ type: 'new_message', chatId, msg: stripHeavy(msg) });
}

function stripHeavy(m){
  const copy = { ...m };
  delete copy.data;
  delete copy.waveform;
  return copy;
}

async function updateMessage(chatId, msgId, patch){
  const chat = state.chats[chatId];
  const m = chat?.messages.find(x => x.id === msgId);
  if(m) Object.assign(m, patch);
  try{
    if(db){
      const existing = await idbGet('messages', msgId);
      if(existing) await idbPut('messages', { ...existing, ...patch, id: msgId, chatId });
    }
  }catch(_){}
  if(bc) bc.postMessage({ type: 'update_message', chatId, msgId, patch });
}

async function removeMessage(chatId, msgId){
  const chat = state.chats[chatId];
  if(chat) chat.messages = chat.messages.filter(m => m.id !== msgId);
  try{ await deleteMessageFromDB(msgId); }catch(_){}
  if(bc) bc.postMessage({ type: 'delete_message', chatId, msgId });
}

/* ---------- Export / Import ---------- */
async function exportChats(){
  const payload = {
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    profile: state.profile,
    settings: state.settings,
    chats: {},
  };
  for(const [id, chat] of Object.entries(state.chats)){
    payload.chats[id] = {
      contactId: chat.contactId,
      unread: chat.unread,
      archived: chat.archived,
      pinned: chat.pinned,
      lastTs: chat.lastTs,
      messages: chat.messages.map(m => {
        // include media as dataURL for portability
        return { ...m };
      }),
    };
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'chiper_app.db';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Экспорт chiper_app.db готов');
}

async function importChats(file){
  const text = await file.text();
  const data = JSON.parse(text);
  if(!data.chats) throw new Error('Неверный формат');
  // clear in-memory; write into IndexedDB on persist
  state.chats = {};
  if(data.profile) state.profile = { ...state.profile, ...data.profile };
  if(data.settings) state.settings = { ...state.settings, ...data.settings };
  for(const [id, chat] of Object.entries(data.chats)){
    state.chats[id] = {
      contactId: chat.contactId || id,
      messages: [],
      unread: chat.unread || 0,
      archived: !!chat.archived,
      pinned: !!chat.pinned,
      lastTs: chat.lastTs || 0,
    };
    await persistChatMeta(id);
    for(const m of (chat.messages || [])){
      if(!m.id) m.id = uid();
      state.chats[id].messages.push(m);
      await persistMessage(id, m);
    }
  }
  saveMeta();
  renderChatList();
  showToast('Импорт завершён');
}

/* Online status is local-only (no fake bots) */

/* ---------- BroadcastChannel full sync ---------- */
let bc = null;
try{
  bc = new BroadcastChannel('chiper_sync_v3');
  bc.onmessage = async (ev) => {
    const d = ev.data;
    if(!d) return;
    if(d.type === 'typing' && d.chatId === state.currentChatId){
      document.getElementById('chatStatus').textContent = 'печатает…';
      clearTimeout(window._typingTO);
      window._typingTO = setTimeout(() => {
        const st = state.onlineStatus[state.currentChatId];
        document.getElementById('chatStatus').textContent = (st && st.online) ? 'в сети' : 'был(а) недавно';
      }, 2000);
    }
    if(d.type === 'new_message'){
      let chat = state.chats[d.chatId];
      if(!chat){
        // auto-create peer chat so other account sees the conversation
        chat = {
          contactId: d.chatId,
          messages: [],
          unread: 0,
          archived: false,
          pinned: false,
          lastTs: d.msg.ts || Date.now(),
        };
        state.chats[d.chatId] = chat;
        persistChatMeta(d.chatId);
      }
      if(chat.messages.some(m => m.id === d.msg.id)) return;
      // we don't have media here — reload from IDB if needed
      chat.messages.push(d.msg);
      chat.lastTs = d.msg.ts;
      if(!isMessageOut(d.msg) && state.currentChatId !== d.chatId) chat.unread = (chat.unread || 0) + 1;
      if(!isMessageOut(d.msg) && !chat.muted) notifyNewMessage(d.chatId, d.msg);
      if(state.currentChatId === d.chatId){
        const el = createBubbleEl(d.msg);
        document.getElementById('messages').appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        scrollMessagesToBottom();
      }
      renderChatList();
    }
    if(d.type === 'update_message'){
      const chat = state.chats[d.chatId];
      const m = chat?.messages.find(x => x.id === d.msgId);
      if(m) Object.assign(m, d.patch);
      if(state.currentChatId === d.chatId) renderMessages();
    }
    if(d.type === 'delete_message'){
      const chat = state.chats[d.chatId];
      if(chat) chat.messages = chat.messages.filter(m => m.id !== d.msgId);
      if(state.currentChatId === d.chatId) renderMessages();
      renderChatList();
    }
    if(d.type === 'online'){
      state.onlineStatus[d.contactId] = { online: d.online, lastSeen: d.lastSeen };
    }
    // WebRTC signaling
    if(d.type === 'call_offer' && d.from !== (state.profile?.username)){
      handleCallOffer(d);
    }
    if(d.type === 'call_answer' && d.from !== (state.profile?.username)){
      handleCallAnswer(d);
    }
    if(d.type === 'call_ice' && d.from !== (state.profile?.username)){
      handleCallIce(d);
    }
    if(d.type === 'call_reject' && d.from !== (state.profile?.username)){
      showToast('Звонок отклонён');
      endCallReal();
    }
    if(d.type === 'call_end' && d.from !== (state.profile?.username)){
      endCallReal();
      showToast('Звонок завершён');
    }
  };
}catch(_){}


/* ========== THEME / ACCENT ========== */
function applyTheme(){
  const t = state.settings.theme || 'system';
  const root = document.documentElement;
  if(t === 'system'){
    root.removeAttribute('data-theme');
    // let prefers-color-scheme CSS handle it; force dark class if needed for toggle
  } else if(t === 'light'){
    root.setAttribute('data-theme', 'light');
  } else {
    root.setAttribute('data-theme', 'dark');
  }
  const tog = document.getElementById('themeToggle');
  if(tog){
    const isDark = t === 'dark' || (t === 'system' && !window.matchMedia('(prefers-color-scheme: light)').matches);
    tog.classList.toggle('on', isDark);
    tog.setAttribute('aria-checked', isDark);
  }
}
function toggleTheme(){
  const order = ['system', 'dark', 'light'];
  const cur = state.settings.theme || 'system';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  state.settings.theme = next;
  applyTheme();
  saveMeta();
  showToast(next === 'system' ? 'Тема: системная' : next === 'dark' ? 'Тёмная тема' : 'Светлая тема');
  if(navigator.vibrate) navigator.vibrate(10);
}
// react to system changes
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if((state.settings.theme || 'system') === 'system') applyTheme();
});
function applyAccent(){
  const a = state.settings.accent || 'blue';
  document.documentElement.setAttribute('data-accent', a==='purple'?'':a);
  document.querySelectorAll('.swatch').forEach(s=>{
    s.classList.toggle('active', s.dataset.c===a);
  });
}
function setAccent(c){
  state.settings.accent = c;
  applyAccent();
  saveMeta();
}
function saveSettings(){
  state.settings.privacy = document.getElementById('privacyToggle')?.classList.contains('on')||false;
  state.settings.notifications = document.getElementById('notifToggle')?.classList.contains('on')||true;
  saveMeta();
}

/* ========== PREMIUM ========== */
let selectedPremiumPlan = 'month';

function isPremium(){
  const p = state.profile || {};
  if(!p.premium) return false;
  if(p.premiumUntil && Date.now() > p.premiumUntil){
    p.premium = false;
    return false;
  }
  return true;
}

function selectPremiumPlan(plan){
  selectedPremiumPlan = plan;
  document.querySelectorAll('.price-card').forEach(c=>{
    c.classList.toggle('active', c.dataset.plan === plan);
  });
  try{ updateCoinsUI(); }catch(_){}
}

function buyPremiumLegacy(){
  const days = selectedPremiumPlan === 'year' ? 365 : 30;
  state.profile.premium = true;
  state.profile.premiumUntil = Date.now() + days * 24 * 60 * 60 * 1000;
  state.profile.badge = 'premium';
  // sync accounts
  try{
    const accounts = loadAccounts();
    const email = state.profile.email;
    if(email && accounts[email]){
      accounts[email].profile = { ...accounts[email].profile, ...state.profile };
      saveAccounts(accounts);
    }
  }catch(_){}
  saveMeta();
  renderPremium();
  renderProfile();
  showToast('Premium активирован ✨');
  if(navigator.vibrate) navigator.vibrate([20,40,20]);
}

function cancelPremium(){
  if(!confirm('Отменить Premium? Фичи станут недоступны.')) return;
  state.profile.premium = false;
  state.profile.premiumUntil = null;
  state.profile.badge = null;
  state.profile.customStatus = '';
  state.profile.profileColor = null;
  try{
    const accounts = loadAccounts();
    const email = state.profile.email;
    if(email && accounts[email]){
      accounts[email].profile = { ...accounts[email].profile, ...state.profile };
      saveAccounts(accounts);
    }
  }catch(_){}
  saveMeta();
  renderPremium();
  renderProfile();
  showToast('Premium отменён');
}

function savePremiumCustomStatus(){
  if(!isPremium()){ showToast('Нужен Premium'); return; }
  const v = (document.getElementById('premiumCustomStatus')?.value || '').trim().slice(0,40);
  state.profile.customStatus = v;
  saveMeta();
  showToast('Статус сохранён');
}

function setProfileColor(c){
  if(!isPremium()){ showToast('Нужен Premium'); go('premium'); return; }
  state.profile.profileColor = c;
  saveMeta();
  document.querySelectorAll('[data-pc]').forEach(s=> s.classList.toggle('active', s.dataset.pc===c));
  showToast('Цвет профиля обновлён');
}

function renderPremium(){
  const active = isPremium();
  const activeBox = document.getElementById('premiumActiveBox');
  const buyBtn = document.getElementById('buyPremiumBtn');
  const badge = document.getElementById('settingsPremiumBadge');
  if(activeBox) activeBox.style.display = active ? 'block' : 'none';
  if(buyBtn) buyBtn.style.display = active ? 'none' : 'block';
  if(badge) badge.style.display = active ? 'inline-flex' : 'none';
  if(active){
    const until = state.profile.premiumUntil ? new Date(state.profile.premiumUntil) : null;
    const el = document.getElementById('premiumUntilLabel');
    if(el && until) el.textContent = until.toLocaleDateString('ru-RU');
    const st = document.getElementById('premiumCustomStatus');
    if(st) st.value = state.profile.customStatus || '';
    document.querySelectorAll('[data-pc]').forEach(s=>{
      s.classList.toggle('active', s.dataset.pc === (state.profile.profileColor||''));
    });
    const sub = document.getElementById('premiumSub');
    if(sub) sub.textContent = 'Подписка активна';
  } else {
    const sub = document.getElementById('premiumSub');
    if(sub) sub.textContent = 'Больше свободы в профиле и чатах';
  }
}

/* ========== PRIVACY PAGE ========== */
function renderPrivacyPage(){
  const profile = state.profile || {};

  // Email
  const emailEl = document.getElementById('privacyEmail');
  if(emailEl) emailEl.textContent = profile.email || '—';

  // Username
  const usernameEl = document.getElementById('privacyUsername');
  if(usernameEl) usernameEl.textContent = profile.username || '—';

  // Created date
  const createdEl = document.getElementById('privacyCreatedAt');
  if(createdEl){
    if(profile.createdAt){
      const date = new Date(profile.createdAt);
      createdEl.textContent = date.toLocaleDateString('ru-RU', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } else {
      createdEl.textContent = '—';
    }
  }

  // Public key
  const pkEl = document.getElementById('privacyPublicKey');
  if(pkEl){
    getE2EEPublicKey().then(pk => {
      if(pk){
        exportPublicKeyBase64(pk).then(b64 => {
          if(pkEl) pkEl.textContent = b64 || '—';
        }).catch(() => {
          if(pkEl) pkEl.textContent = '—';
        });
      } else {
        if(pkEl) pkEl.textContent = 'Ключ не создан';
      }
    }).catch(() => {
      if(pkEl) pkEl.textContent = '—';
    });
  }
  try {
    if (typeof ChiperPrivacy !== 'undefined' && ChiperPrivacy.applyPrivacyForm) {
      ChiperPrivacy.applyPrivacyForm();
    }
  } catch (_) {}
}

async function changeEmail(){
  const newEmail = (document.getElementById('newEmailInput')?.value || '').trim().toLowerCase();
  if(!newEmail || !isValidEmail(newEmail)){
    showToast('Введите корректный email');
    return;
  }

  if(newEmail === state.profile?.email){
    showToast('Это ваш текущий email');
    return;
  }

  try{
    await requestOtp(newEmail);
    showToast('Код отправлен на новый email. Войдите с новым email для подтверждения.');
    // В реальном приложении нужна дополнительная логика для смены email
  }catch(e){
    showToast('Ошибка: ' + (e.message || 'Не удалось отправить код'));
  }
}

async function setCloudPassword(){
  const password = document.getElementById('cloudPasswordInput')?.value || '';
  const confirm = document.getElementById('cloudPasswordConfirm')?.value || '';

  if(!password || password.length < 8){
    showToast('Пароль должен быть минимум 8 символов');
    return;
  }

  if(password !== confirm){
    showToast('Пароли не совпадают');
    return;
  }

  try{
    // Хешируем пароль
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // Сохраняем хеш в профиль
    state.profile.passwordHash = hashHex;
    await saveProfileToServer(state.profile);
    persistProfileToAccounts();

    document.getElementById('cloudPasswordInput').value = '';
    document.getElementById('cloudPasswordConfirm').value = '';

    showToast('Пароль установлен ✓');
  }catch(e){
    console.error('Set password error:', e);
    showToast('Ошибка установки пароля');
  }
}

function confirmDeleteAccount(){
  if(!confirm('Вы уверены, что хотите удалить аккаунт? Это действие необратимо!')){
    return;
  }

  if(!confirm('Все ваши данные будут удалены навсегда. Продолжить?')){
    return;
  }

  deleteAccount();
}

async function deleteAccount(){
  try{
    // Удаляем из локального хранилища
    const accounts = loadAccounts();
    const email = state.profile?.email;
    if(email && accounts[email]){
      delete accounts[email];
      saveAccounts(accounts);
    }

    // Очищаем состояние
    state.profile = {};
    state.loggedIn = false;
    state.chats = {};

    // Очищаем IndexedDB
    if(db){
      try{
        await idbClear('chats');
        await idbClear('messages');
        await idbClear('media');
      }catch(_){}
    }

    // Очищаем localStorage
    try{
      localStorage.removeItem(META_KEY);
      localStorage.removeItem(ACCOUNTS_KEY);
      localStorage.removeItem(E2EE_PRIVATE_KEY_STORAGE);
      localStorage.removeItem(E2EE_PUBLIC_KEY_STORAGE);
    }catch(_){}

    document.body.classList.remove('authed');
    showToast('Аккаунт удалён');
    go('login');

  }catch(e){
    console.error('Delete account error:', e);
    showToast('Ошибка удаления аккаунта');
  }
}

/* ========== NAV ========== */
const AUTH_SCREENS = new Set(['login', 'register', 'onboarding']);
const APP_SCREENS = new Set(['chats','chat','settings','profile','profile-edit','storage','premium','customize','newchat','archive','userinfo','admin','coins','privacy']);

function isAuthed(){
  return !!(state.loggedIn && state.profile && state.profile.uid && (state.profile.username || window._pendingReg));
}

function setAuthUI(loggedIn){
  state.loggedIn = !!loggedIn;
  document.body.classList.toggle('authed', !!loggedIn);
  if(!loggedIn){
    // force only login visible
    document.querySelectorAll('.screen.active').forEach(s => s.classList.remove('active'));
    const login = document.getElementById('screen-login');
    if(login) login.classList.add('active');
    closeDrawer?.();
    document.getElementById('callOverlay')?.classList.remove('active');
    document.getElementById('incomingCallBanner')?.classList.remove('show');
  }
}

function requireAuth(screenName){
  if(AUTH_SCREENS.has(screenName)) return true;
  // onboarding allowed during pending registration
  if(screenName === 'onboarding' && window._pendingReg) return true;
  if(state.loggedIn && state.profile?.uid && state.profile?.username) return true;
  // incomplete profile → onboarding
  if(state.loggedIn && state.profile?.uid && !state.profile?.username){
    return screenName === 'onboarding';
  }
  return false;
}

function go(name){
  if(state.currentChatId && name !== 'chat' && name !== 'userinfo'){
    try{ saveDraft(); }catch(_){}
    try{ exitSelectMode(); }catch(_){}
  }

  // Auth gate — never open app screens without a real account
  if(!requireAuth(name)){
    if(window._pendingReg) name = 'onboarding';
    else name = 'login';
  }
  // If fully authed, don't stay on login/register
  if(state.loggedIn && state.profile?.username && (name === 'login' || name === 'register')){
    name = 'chats';
  }

  const cur = document.querySelector('.screen.active');
  const next = document.getElementById('screen-' + name);
  if(!next){ console.warn('Screen not found:', name); return; }
  if(cur === next) return;
  if(cur){
    cur.classList.add('leaving');
    cur.classList.remove('active');
    setTimeout(()=>{ cur.classList.remove('leaving'); }, 360);
  }
  next.classList.remove('leaving');
  next.classList.add('active');
  document.body.classList.toggle('authed', !!(state.loggedIn && state.profile?.username));

  // nav active states + bubble
  document.querySelectorAll('.bottom-nav .nav-item').forEach(n=>{
    n.classList.remove('active');
  });
  let targetBtn = null;
  document.querySelectorAll('.bottom-nav').forEach(nav=>{
    const items = nav.querySelectorAll('.nav-item');
    items.forEach(n=>{
      if((name==='chats'||name==='archive'||name==='newchat') && n.getAttribute('aria-label')==='Чаты'){ n.classList.add('active'); targetBtn = n; }
      if((name==='profile'||name==='profile-edit') && n.getAttribute('aria-label')==='Профиль'){ n.classList.add('active'); targetBtn = n; }
      if(name==='settings' && n.getAttribute('aria-label')==='Настройки'){ n.classList.add('active'); targetBtn = n; }
    });
    if(targetBtn && nav.contains(targetBtn)) moveNavBubble(targetBtn);
  });

  if(name==='chats' || name==='chat'){
    // Two-column layout on tablet (768+) and desktop (900+)
    if(window.innerWidth >= 768) document.getElementById('app').classList.add('desktop-chat');
    else document.getElementById('app').classList.remove('desktop-chat');
  }
  if(name==='chats') renderChatList();
  if(name==='archive') renderArchive();
  if(name==='newchat'){ switchNewTab('users'); searchUsersByUsername(); }
  if(name==='profile') renderProfile();
  if(name==='profile-edit') fillProfileEditForm();
  if(name==='storage') renderStorage();
  if(name==='premium') renderPremium();
  if(name==='userinfo') renderUserInfo();
  if(name==='admin'){
    renderAdminGate();
    updateCoinsUI();
  }
  if(name==='coins'){
    renderCoinsPage();
    updateCoinsUI();
  }
  if(name==='settings'){
    renderPremium();
    updateCoinsUI();
    document.getElementById('privacyToggle')?.classList.toggle('on', state.settings.privacy);
    document.getElementById('notifToggle')?.classList.toggle('on', state.settings.notifications!==false);
  }
  if(name==='privacy'){
    renderPrivacyPage();
  }
  if(name==='customize'){
    document.getElementById('themeToggle')?.classList.toggle('on', document.documentElement.getAttribute('data-theme') !== 'light' && (state.settings.theme !== 'light'));
    const themeIsDark = (state.settings.theme === 'dark') || (state.settings.theme !== 'light' && document.documentElement.getAttribute('data-theme') !== 'light');
    const tt = document.getElementById('themeToggle');
    if(tt){ tt.classList.toggle('on', themeIsDark || state.settings.theme === 'system' || !state.settings.theme); tt.setAttribute('aria-checked', tt.classList.contains('on')); }
    document.getElementById('compactToggle')?.classList.toggle('on', !!state.settings.compact);
    const ts = document.getElementById('themeScheduleToggle');
    if(ts){ ts.classList.toggle('on', !!state.settings.themeSchedule); ts.setAttribute('aria-checked', !!state.settings.themeSchedule); }
    // accent swatches
    document.querySelectorAll('#screen-customize .swatch[data-c]').forEach(s=>{
      s.classList.toggle('active', s.dataset.c === (state.settings.accent || 'blue'));
    });
    renderBubbleStylePicker();
    const badge = document.getElementById('bubbleStyleProBadge');
    if(badge) badge.style.display = isPremium() ? '' : 'none';
    const hint = document.getElementById('bubbleStyleHint');
    if(hint) hint.textContent = isPremium()
      ? 'Выберите один из 10 стилей пузырьков исходящих сообщений.'
      : 'Стиль 1 доступен всем. Остальные 9 — в Chiper Premium.';
    try{ renderAvatarGallery(); }catch(_){}
    try{
      const pos = state.profile?.avatarPos || state.profile?.avatarPosition || 'center';
      document.querySelectorAll('#avatarPosPicker .avatar-pos-btn').forEach(btn=>{
        btn.classList.toggle('active', btn.dataset.pos === pos);
      });
    }catch(_){}
    try{ applyAllCustomUI(); }catch(_){}
  }
  hideCtx(); hideReactions(); closeDrawer();
}

function moveNavBubble(btn){
  if(!btn) return;
  const nav = btn.closest('.bottom-nav');
  if(!nav) return;
  const bubble = nav.querySelector('.nav-bubble');
  if(!bubble) return;
  const isFab = btn.classList.contains('fab');
  const navRect = nav.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  let left = btnRect.left - navRect.left;
  let width = btnRect.width;

  // For FAB: make bubble circular and centered on the button
  if(isFab){
    const size = Math.min(btnRect.width, btnRect.height) - 4;
    width = size;
    left = btnRect.left - navRect.left + (btnRect.width - size) / 2;
  }

  // Animate bubble
  bubble.style.width = width + 'px';
  bubble.style.left = left + 'px';
  bubble.classList.toggle('fab-mode', isFab);

  // Active state + icon pop animation
  nav.querySelectorAll('.nav-item').forEach(n => {
    n.classList.remove('active', 'just-activated');
  });
  btn.classList.add('active');
  // Trigger pop only when switching (not on init)
  if(!btn._navInit){
    btn.classList.add('just-activated');
    setTimeout(() => btn.classList.remove('just-activated'), 450);
  }
  btn._navInit = false;
}

/* ========== AUTH ========== */
/* ========== AUTH (email, local only) ========== */
// ACCOUNTS_KEY defined near META_KEY

function isValidEmail(e){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');
}
function showAuthError(id, msg){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = msg || '';
  el.classList.toggle('show', !!msg);
}
function hashPass(p){
  // lightweight local hash (demo, not production-grade crypto)
  let h = 0;
  for(let i=0;i<p.length;i++){ h = ((h<<5)-h) + p.charCodeAt(i); h |= 0; }
  return 'h' + (h >>> 0).toString(16);
}

function normalizeUsername(u){
  let s = String(u || '').trim().toLowerCase();
  if(!s.startsWith('@')) s = '@' + s;
  return s;
}

async function isUsernameTaken(username, excludeUid){
  const un = normalizeUsername(username);
  if(un.length < 3) return true;
  const uid = excludeUid || state.profile?.uid || state.profile?.email;
  // Local accounts first
  if (await fsIsUsernameTaken(un, uid)) return true;
  // Server check (unique constraint is the real source of truth)
  try {
    const data = await getJson(getFunctionUrl('check-username') + '?username=' + encodeURIComponent(un));
    if (data && data.exists) {
      // Allow if the existing profile is the current user
      if (data.profile && (data.profile.id === uid || data.profile.username === un) &&
          (state.profile?.username === un || state.profile?.id === data.profile.id)) {
        return false;
      }
      return true;
    }
  } catch (e) {
    console.warn('isUsernameTaken server check failed', e.message);
  }
  return false;
}

function getCurrentUserKey(){
  return normalizeUsername(state.profile?.username || '');
}

function isMessageOut(m){
  if(m.from){
    return normalizeUsername(m.from) === getCurrentUserKey();
  }
  return !!m.out;
}

function dmChatId(userA, userB){
  const a = normalizeUsername(userA).replace(/^@/,'').toLowerCase();
  const b = normalizeUsername(userB).replace(/^@/,'').toLowerCase();
  if(!a || !b) return b || a || 'unknown';
  return 'dm_' + [a, b].sort().join('_');
}

function peerFromDmId(chatId){
  if(!String(chatId).startsWith('dm_')) return String(chatId).replace(/^@/,'');
  const parts = String(chatId).slice(3).split('_');
  const me = getCurrentUserKey().replace(/^@/,'').toLowerCase();
  if(parts[0] === me) return parts[1] || parts[0];
  if(parts[1] === me) return parts[0];
  return parts[0];
}

function normalizeOtpCode(value){
  return String(value || '').replace(/\s+/g, '').trim();
}


async function doLogin(){
  try{
    showAuthError('loginError', '');
    const email = (document.getElementById('loginUser')?.value || '').trim().toLowerCase();
    if(!isValidEmail(email)){ showAuthError('loginError', 'Введите корректный email'); return; }
    const btn = document.getElementById('loginBtn');
    if(btn){ btn.disabled = true; btn.textContent = 'Отправка…'; }

    await requestOtp(email);
    window._pendingAuth = { email, createdAt: Date.now() };
    const hint = document.getElementById('otpHint');
    if(hint){ hint.textContent = `Код отправлен на ${email}`; }
    go('register');
    showToast('Код отправлен на email');
  }catch(e){
    console.error(e);
    showAuthError('loginError', e.message || 'Ошибка отправки кода');
  }finally{
    const btn = document.getElementById('loginBtn');
    if(btn){ btn.disabled = false; btn.textContent = 'Получить код'; }
  }
}

async function doRegister(){
  try{
    showAuthError('regError', '');
    const code = normalizeOtpCode(document.getElementById('otpCode')?.value || '');
    const pending = window._pendingAuth;
    if(!pending){ showAuthError('regError', 'Сначала отправьте код'); go('login'); return; }
    if(!code){ showAuthError('regError', 'Введите код'); return; }
    const btn = document.getElementById('regBtn');
    if(btn){ btn.disabled = true; btn.textContent = 'Проверка…'; }

    const verifyResult = await verifyOtp(pending.email, code);
    const email = pending.email.toLowerCase();
    const accounts = loadAccounts();
    const localProfile = accounts[email]?.profile || null;
    const remoteProfile = verifyResult?.profile || await loadProfileByEmail(email);
    const existingProfile = remoteProfile || localProfile;
    if(verifyResult && verifyResult.token) {
      if(!accounts[email]) accounts[email] = { profile: existingProfile || { email } };
      accounts[email].token = verifyResult.token;
      saveAccounts(accounts);
    }

    if(existingProfile?.username){
      const profile = { ...existingProfile, email, uid: existingProfile.uid || ('local_' + Date.now().toString(36)) };
      if(!accounts[email]) accounts[email] = { profile: { email, uid: profile.uid, name: '', username: '', coins: 0, stars: 0 } };
      accounts[email].profile = profile;
      if (verifyResult && verifyResult.token) accounts[email].token = verifyResult.token;
      saveAccounts(accounts);
      state.profile = profile;
      state.loggedIn = true;
      document.body.classList.add('authed');
      await prepareCurrentUserProfile().catch(()=>{});
      await openDB();
      await loadAllChats();
      try{ rebuildUsersIndex(); }catch(_){ }
      state.settings = state.settings || { theme:'system', accent:'blue', privacy:false, notifications:true, compact:false, themeSchedule:false, bubbleStyle:0 };
      saveMeta();
      window._pendingAuth = null;
      go('chats');
      try{ renderChatList(); renderProfile(); updateCoinsUI(); }catch(_){ }
      showToast('С возвращением!');
      try {
        if (typeof ChiperSync !== 'undefined' && ChiperSync.fullSyncAfterLogin) {
          ChiperSync.fullSyncAfterLogin().then(() => {
            try { renderChatList(); } catch (_) {}
          });
        }
      } catch (_) {}
      return;
    }

    const uid = 'local_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    window._pendingReg = { email, uid, viaGoogle: false };
    const local = email.split('@')[0].replace(/[^a-z0-9._]/gi,'').slice(0,20) || 'user';
    const ou = document.getElementById('onboardUser');
    const on = document.getElementById('onboardName');
    if(ou) ou.value = '@' + local;
    if(on) on.value = local.charAt(0).toUpperCase() + local.slice(1);
    go('onboarding');
    showToast('Создайте профиль');
  }catch(e){
    console.error(e);
    showAuthError('regError', e.message || 'Ошибка подтверждения');
  }finally{
    const btn = document.getElementById('regBtn');
    if(btn){ btn.disabled = false; btn.textContent = 'Подтвердить'; }
  }
}

async function authWithGoogle(mode){
  showToast('Google вход отключён — используем email + код.');
}

function selectPresetAvatar(styleClass, label){
  const av = document.getElementById('onboardAvatar');
  if(!av) return;
  document.querySelectorAll('.avatar-preset').forEach(btn => btn.classList.toggle('active', btn.textContent === label));
  av.className = `avatar ${styleClass} pressable`;
  av.style.backgroundImage = '';
  av.textContent = label;
  window._onboardAvatarData = null;
  av.setAttribute('data-preset', styleClass);
}

function handleOnboardAvatar(input){
  const file = input.files?.[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    window._onboardAvatarData = ev.target.result;
    const av = document.getElementById('onboardAvatar');
    av.className = 'avatar av-g3 pressable';
    av.style.backgroundImage = `url(${ev.target.result})`;
    av.textContent = '';
    document.querySelectorAll('.avatar-preset').forEach(btn => btn.classList.remove('active'));
  };
  reader.readAsDataURL(file);
}

async function finishOnboarding(){
  const btn = document.getElementById('onboardDoneBtn');
  try{
    showAuthError('onboardError', '');
    if(btn){ btn.disabled = true; btn.textContent = 'Сохранение…'; }

    if(!window._pendingReg){
      showAuthError('onboardError', 'Сессия регистрации потеряна — зарегистрируйтесь снова');
      go('register');
      return;
    }
    const pending = window._pendingReg;
    const name = (document.getElementById('onboardName')?.value || '').trim();
    let username = (document.getElementById('onboardUser')?.value || '').trim();
    const bio = (document.getElementById('onboardBio')?.value || '').trim();
    if(!name){ showAuthError('onboardError', 'Укажите имя'); return; }
    username = normalizeUsername(username);
    if(username.length < 3 || !/^@[a-z0-9._]{2,31}$/i.test(username)){
      showAuthError('onboardError', 'Некорректный @username');
      return;
    }
    if(await isUsernameTaken(username, pending.uid || pending.email)){
      showAuthError('onboardError', 'Этот @username уже занят');
      return;
    }

    const profile = {
      uid: pending.uid || ('local_' + Date.now().toString(36)),
      email: (pending.email || '').toLowerCase(),
      name: name.slice(0, 64),
      username,
      bio: bio.slice(0, 500),
      avatar: window._onboardAvatarData || null,
      avatarType: window._onboardAvatarData ? 'image' : null,
      avatars: window._onboardAvatarData ? [{ id: 'av_main', data: window._onboardAvatarData, type: 'image' }] : [],
      isAdmin: false,
      coins: 0,
      stars: 0,
      verified: false,
      premium: false,
      premiumUntil: 0,
      createdAt: Date.now(),
    };

    const accounts = loadAccounts();
    const email = profile.email;
    if(!accounts[email]) accounts[email] = { profile: { email, uid: profile.uid, name: '', username: '', coins: 0, stars: 0 } };
    accounts[email].profile = profile;
    saveAccounts(accounts);

    try {
      const saveResult = await saveProfileToServer(profile);
      if (!saveResult) throw new Error('Сервер не ответил при сохранении профиля');
      console.log('✓ Profile saved to server:', saveResult);
      // Keep Supabase UUID on the client profile (needed for DMs / memberships)
      if (saveResult.profile && saveResult.profile.id) {
        profile.id = saveResult.profile.id;
      } else if (saveResult.id) {
        profile.id = saveResult.id;
      }
      accounts[email].profile = profile;
      saveAccounts(accounts);
    } catch (saveErr) {
      console.error('❌ ОШИБКА:', saveErr.message);
      showToast('❌ Не удалось сохранить профиль: ' + (saveErr.message || 'ошибка сервера'));
      throw saveErr; // Останови регистрацию
    }

    state.profile = profile;
    state.loggedIn = true;
    document.body.classList.add('authed');
    await prepareCurrentUserProfile().catch(()=>{});
    state.settings = state.settings || {
      theme:'system', accent:'blue', privacy:false, notifications:true,
      compact:false, themeSchedule:false, bubbleStyle:0
    };
    window._pendingReg = null;
    window._pendingAuth = null;
    window._onboardAvatarData = null;
    saveMeta();
    await openDB();
    await loadAllChats();
    try{ rebuildUsersIndex(); }catch(_){ }
    go('chats');
    try{ renderChatList(); renderProfile(); updateCoinsUI(); }catch(_){ }
    showToast('Профиль создан ✓');
    try {
      if (typeof ChiperSync !== 'undefined' && ChiperSync.fullSyncAfterLogin) {
        ChiperSync.fullSyncAfterLogin().then(() => { try { renderChatList(); } catch (_) {} });
      }
    } catch (_) {}
  }catch(e){
    console.error('finishOnboarding', e);
    showAuthError('onboardError', e.message || 'Не удалось сохранить профиль');
    showToast('Ошибка сохранения профиля');
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = 'Готово'; }
  }
}



function renderChatList(){
  const list = document.getElementById('chatList');
  if(!list) return;
  const chats = Object.entries(state.chats)
    .filter(([,c])=>!c.archived)
    .sort((a,b)=>(b[1].pinned?1:0)-(a[1].pinned?1:0) || (b[1].lastTs||0)-(a[1].lastTs||0));
  list.innerHTML = '';
  chats.forEach(([id, chat])=>{
    const contact = getContact(chat.contactId || id);
    const last = chat.messages[chat.messages.length-1];
    let lastText = last ? formatLast(last) : 'Нет сообщений';
    const hasDraft = state.drafts && state.drafts[id];
    if(hasDraft) lastText = 'Черновик: ' + state.drafts[id].slice(0,40);
    const time = last ? formatTime(last.ts) : '';
    const wrap = document.createElement('div');
    wrap.className = 'chat-row-wrap';
    wrap.innerHTML = `<div class="chat-row-actions">
      <button class="act mute" type="button">🔕<span>Mute</span></button>
      <button class="act arch" type="button">📦<span>Архив</span></button>
    </div>`;
    const row = document.createElement('div');
    row.className = 'chat-row glass r22 pressable';
    row.dataset.name = contact.name.toLowerCase();
    row.dataset.search = ((contact.name || '') + ' ' + (contact.username || '') + ' ' + lastText).toLowerCase();
    row.dataset.id = id;
    row.dataset.chatType = chat.type || (chat.isChannel ? 'channel' : chat.isGroup ? 'group' : 'personal');
    row.setAttribute('role','button');
    row.tabIndex = 0;
    const muteIcon = chat.muted ? ' 🔕' : '';
    const pinIcon = chat.pinned ? '📌 ' : '';
    row.innerHTML = `
      <div class="avatar ${contact.gradient}" style="width:48px;height:48px;font-size:15px;">${contact.initials}${contact.online?'<span class="online-dot" style="width:10px;height:10px;"></span>':''}</div>
      <div class="chat-meta">
        <div class="chat-top-line"><div class="chat-name">${pinIcon}${escapeHtml(contact.name)}${muteIcon}</div><div class="chat-time">${time}</div></div>
        <div class="chat-top-line"><div class="chat-last">${hasDraft?'<span class="draft-dot"></span>':''}${escapeHtml(lastText)}</div>${chat.unread?`<div class="badge">${chat.unread}</div>`:''}</div>
      </div>`;
    row.onclick = (e)=>{ if(!longPressed && !wrap.classList.contains('swiped')) openChat(id); else if(wrap.classList.contains('swiped')){ wrap.classList.remove('swiped'); row.style.transform=''; } };
    row.oncontextmenu = (e)=>{ e.preventDefault(); showChatCtx(e, id); };
    setupLongPress(row, (e)=> showChatCtx(e, id));
    wrap.appendChild(row);
    wrap.querySelector('.act.arch').onclick = (e)=>{ e.stopPropagation(); chat.archived=true; persistChatMeta(id); renderChatList(); showToast('В архиве'); };
    wrap.querySelector('.act.mute').onclick = (e)=>{ e.stopPropagation(); chat.muted=!chat.muted; persistChatMeta(id); renderChatList(); showToast(chat.muted?'Без уведомлений':'Уведомления вкл.'); };
    setupChatRowSwipe(wrap, id);
    list.appendChild(wrap);
  });
  if(!chats.length){
    list.innerHTML = `<div class="empty-state">
      <div class="emoji">💬</div>
      <div class="title">Пока нет чатов</div>
      <div class="desc">Начните переписку, создайте группу или канал</div>
      <button class="cta gradient-btn" onclick="go('newchat')">Новый чат</button>
    </div>`;
  }
  const archCount = Object.values(state.chats).filter(c=>c.archived).length;
  const ac = document.getElementById('archiveCount');
  if(ac) ac.textContent = archCount + ' чат' + (archCount===1?'':archCount<5?'а':'ов');
}

function setChatFilter(filter, btn){
  document.querySelectorAll('#chatFilterTabs .filter-tab').forEach(t => t.classList.remove('active'));
  if(btn) btn.classList.add('active');
  state.chatFilter = filter || 'all';
  const labels = { all:'Все', personal:'Личные', groups:'Группы', channels:'Каналы' };
  showToast(labels[filter] || 'Все');
  // Filter by chat type when available
  document.querySelectorAll('#chatList .chat-row-wrap').forEach(wrap => {
    const row = wrap.querySelector('.chat-row');
    if(!row) return;
    const type = row.dataset.chatType || 'personal';
    const show = filter === 'all' || type === filter || (filter === 'personal' && type !== 'group' && type !== 'channel');
    wrap.style.display = show ? '' : 'none';
  });
}

function formatLast(m){
  if(m.type==='voice') return '🎤 Голосовое';
  if(m.type==='image') return '📷 Фото';
  if(m.type==='file') return '📎 '+(m.fileName||'Файл');
  return m.text || '';
}
function formatTime(ts){
  const d = new Date(ts);
  const now = new Date();
  if(d.toDateString()===now.toDateString()) return d.getHours()+':'+String(d.getMinutes()).padStart(2,'0');
  const yest = new Date(now); yest.setDate(yest.getDate()-1);
  if(d.toDateString()===yest.toDateString()) return 'Вчера';
  return d.getDate()+'.'+String(d.getMonth()+1).padStart(2,'0');
}

function renderArchive(){
  const list = document.getElementById('archiveList');
  if(!list) return;
  list.innerHTML = '';
  const archived = Object.entries(state.chats).filter(([,c])=>c.archived)
    .sort((a,b)=>(b[1].lastTs||0)-(a[1].lastTs||0));
  if(!archived.length){
    list.innerHTML = `<div class="empty-state"><div class="emoji">📦</div><div class="title">Архив пуст</div><div class="desc">Свайпните чат влево или через меню «Архивировать»</div></div>`;
    return;
  }
  archived.forEach(([id,chat])=>{
    const contact = getContact(chat.contactId||id);
    const last = chat.messages[chat.messages.length-1];
    const row = document.createElement('div');
    row.className = 'chat-row glass r22 pressable';
    row.style.position = 'relative';
    row.innerHTML = `
      <div class="avatar ${contact.gradient}" style="width:48px;height:48px;font-size:15px;">${contact.initials}</div>
      <div class="chat-meta" style="flex:1;min-width:0;">
        <div class="chat-top-line"><div class="chat-name">${escapeHtml(contact.name || chat.title || 'Чат')}</div><div class="chat-time">${last?formatTime(last.ts):''}</div></div>
        <div class="chat-top-line"><div class="chat-last">${escapeHtml(formatLast(last||{}))}</div></div>
      </div>
      <button class="pressable" type="button" title="Разархивировать" style="flex-shrink:0;width:40px;height:40px;border-radius:12px;border:1px solid var(--border);background:var(--glass);color:var(--text-secondary);font-size:16px;cursor:pointer;">📤</button>`;
    const unarchBtn = row.querySelector('button');
    unarchBtn.onclick = (e)=>{
      e.stopPropagation();
      chat.archived = false;
      persistChatMeta(id);
      renderArchive();
      renderChatList();
      showToast('Чат восстановлен');
    };
    row.onclick = ()=> openChat(id);
    list.appendChild(row);
  });
}

function switchNewTab(tab){
  document.getElementById('tabUsers')?.classList.toggle('active', tab==='users');
  document.getElementById('tabGroup')?.classList.toggle('active', tab==='group');
  document.getElementById('tabChannel')?.classList.toggle('active', tab==='channel');
  document.getElementById('newUsersPane').style.display = tab==='users' ? '' : 'none';
  document.getElementById('newGroupPane').style.display = tab==='group' ? '' : 'none';
  document.getElementById('newChannelPane').style.display = tab==='channel' ? '' : 'none';
  if(tab === 'group'){ groupWizardNext(1); renderGroupMemberChips(); }
  if(tab === 'channel') channelWizardNext(1);
}

function searchUsersByUsername(){
  rebuildUsersIndex();
  const list = document.getElementById('contactList');
  if(!list) return;
  const q = (document.getElementById('contactSearch')?.value || '').trim().toLowerCase().replace(/^@/,'');
  list.innerHTML = '';
  const results = [];
  const seen = new Set();
  Object.values(state.usersIndex).forEach(u=>{
    const id = u.id || (u.username||'').replace(/^@/,'');
    if(seen.has(id)) return;
    const un = (u.username||'').toLowerCase().replace(/^@/,'');
    const name = (u.name||'').toLowerCase();
    if(!q || un.includes(q) || name.includes(q)){
      seen.add(id);
      results.push(u);
    }
  });
  // allow starting chat with typed username even if not in index
  if(q && results.length===0){
    results.push({ id:q, name:q, username:'@'+q, bio:'Новый пользователь', gradient:'av-g1' });
  }
  if(!results.length){
    list.innerHTML = `<div style="text-align:center;padding:32px 16px;color:var(--text-secondary);font-size:14px;">
      Введите @username чтобы найти или начать чат
    </div>`;
    return;
  }
  results.forEach(c=>{
    const id = (c.id || (c.username||'').replace(/^@/,'')).toLowerCase();
    const initials = (c.name||id).split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const row = document.createElement('div');
    row.className = 'contact-row glass r20 pressable';
    row.dataset.name = (c.name||'').toLowerCase();
    row.innerHTML = `
      <div class="avatar ${c.gradient||'av-g1'}" style="width:48px;height:48px;font-size:15px;">${escapeHtml(initials)}</div>
      <div><div class="name">${escapeHtml(c.name||id)}</div><div class="sub">${escapeHtml(c.username||('@'+id))}</div></div>`;
    row.onclick = ()=>{
      const chatId = dmChatId(getCurrentUserKey(), id);
      if(!state.chats[chatId]){
        state.chats[chatId] = { contactId: id, messages:[], unread:0, archived:false, pinned:false, lastTs:Date.now() };
        persistChatMeta(chatId);
      }
      openChat(chatId);
    };
    list.appendChild(row);
  });
}

let pendingGroupMembers = [];
let groupAvatarData = null;
let channelAvatarData = null;

function previewGroupAvatar(input){
  const f = input.files?.[0]; if(!f) return;
  const r = new FileReader();
  r.onload = e => { groupAvatarData = e.target.result; const el=document.getElementById('groupAvatarPreview'); el.style.backgroundImage=`url(${e.target.result})`; el.textContent=''; };
  r.readAsDataURL(f);
}
function previewChannelAvatar(input){
  const f = input.files?.[0]; if(!f) return;
  const r = new FileReader();
  r.onload = e => { channelAvatarData = e.target.result; const el=document.getElementById('channelAvatarPreview'); el.style.backgroundImage=`url(${e.target.result})`; el.textContent=''; };
  r.readAsDataURL(f);
}

function groupWizardNext(step){
  if(step === 2){
    const name = (document.getElementById('groupName')?.value||'').trim();
    if(name.length < 2){ showToast('Укажите название'); return; }
  }
  if(step === 3){
    document.getElementById('groupConfirmName').textContent = document.getElementById('groupName').value || '—';
    const me = 1 + pendingGroupMembers.length;
    document.getElementById('groupConfirmMembers').textContent = String(me);
  }
  [1,2,3].forEach(s=>{
    const el = document.getElementById('groupStep'+s);
    if(el) el.style.display = s===step ? '' : 'none';
  });
  document.querySelectorAll('#groupWizardSteps .wiz-dot').forEach(d=>{
    const n = +d.dataset.step;
    d.classList.toggle('active', n===step);
    d.classList.toggle('done', n<step);
  });
}

function channelWizardNext(step){
  if(step === 2){
    const name = (document.getElementById('channelName')?.value||'').trim();
    let handle = (document.getElementById('channelHandle')?.value||'').trim();
    if(name.length < 2){ showToast('Укажите название'); return; }
    if(!handle || handle.replace('@','').length < 2){ showToast('Укажите @handle'); return; }
  }
  if(step === 3){
    document.getElementById('channelConfirmName').textContent = document.getElementById('channelName').value || '—';
    let h = document.getElementById('channelHandle').value || '';
    if(!h.startsWith('@')) h = '@'+h;
    document.getElementById('channelConfirmHandle').textContent = h;
  }
  [1,2,3].forEach(s=>{
    const el = document.getElementById('channelStep'+s);
    if(el) el.style.display = s===step ? '' : 'none';
  });
  ['chDot1','chDot2','chDot3'].forEach((id,i)=>{
    const d = document.getElementById(id);
    if(!d) return;
    d.classList.toggle('active', i+1===step);
    d.classList.toggle('done', i+1<step);
  });
}

function addGroupMember(){
  const input = document.getElementById('groupUserInput');
  if(!input) return;
  let v = (input.value || '').trim().toLowerCase().replace(/^@/,'');
  if(!v) return;
  if(pendingGroupMembers.includes(v)){ showToast('Уже добавлен'); return; }
  if(pendingGroupMembers.length >= 50){ showToast('Максимум 50 участников'); return; }
  pendingGroupMembers.push(v);
  input.value = '';
  renderGroupMemberChips();
}
function removeGroupMember(u){
  pendingGroupMembers = pendingGroupMembers.filter(x => x !== u);
  renderGroupMemberChips();
}
function renderGroupMemberChips(){
  const box = document.getElementById('groupMemberChips');
  if(!box) return;
  if(!pendingGroupMembers.length){
    box.innerHTML = '<span class="hint-text">Пока нет участников</span>';
    return;
  }
  box.innerHTML = pendingGroupMembers.map(u =>
    `<span class="member-chip">@${escapeHtml(u)} <button type="button" onclick="removeGroupMember('${u}')" aria-label="Удалить">×</button></span>`
  ).join('');
}

async function createGroupOrChannel(kind){
  const isChannel = kind === 'channel';
  const myId = (typeof getMyProfileId === 'function' ? getMyProfileId() : null) || state.profile?.id || state.profile?.uid || null;

  const nameEl = document.getElementById(isChannel ? 'channelName' : 'groupName');
  const title = (nameEl?.value || '').trim();
  if (title.length < 2) {
    showToast('Укажите название (минимум 2 символа)');
    return;
  }

  let description = '';
  let handle = '';
  let memberIds = [];
  let memberUsernames = [];

  if (isChannel) {
    handle = (document.getElementById('channelHandle')?.value || '').trim().replace(/^@+/, '');
    if (!handle || handle.length < 2) {
      showToast('Укажите @handle канала');
      return;
    }
    description = (document.getElementById('channelDesc')?.value || '').trim() || 'Канал';
  } else {
    description = (document.getElementById('groupDesc')?.value || '').trim() || 'Группа';
    // Prefer window.groupMembers (objects with id), fallback to pendingGroupMembers (usernames)
    if (Array.isArray(window.groupMembers) && window.groupMembers.length) {
      window.groupMembers.forEach((m) => {
        if (m && m.id) memberIds.push(m.id);
        if (m && m.username) memberUsernames.push(String(m.username).replace(/^@/, ''));
      });
    } else if (Array.isArray(pendingGroupMembers) && pendingGroupMembers.length) {
      memberUsernames = pendingGroupMembers.slice();
    }
  }

  const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
  const participants = [];
  if (myId && isUuid(myId)) participants.push(myId);
  memberIds.forEach((id) => {
    if (isUuid(id) && !participants.includes(id)) participants.push(id);
  });

  // Always create local chat so UI works even if server fails
  const localId = isChannel
    ? ('channel_' + handle.toLowerCase())
    : ('group_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));

  const avatarData = isChannel ? channelAvatarData : groupAvatarData;

  const localChat = {
    contactId: localId,
    title,
    handle: isChannel ? ('@' + handle) : null,
    messages: [],
    unread: 0,
    archived: false,
    pinned: false,
    muted: false,
    lastTs: Date.now(),
    isGroup: !isChannel,
    isChannel: !!isChannel,
    bio: description,
    members: memberUsernames.length ? memberUsernames : (memberIds.slice()),
    memberUids: memberIds.slice(),
    avatar: avatarData || null,
    subscribed: true,
    joined: true,
    subscribers: isChannel ? 1 : null,
    isPublic: true,
    createdBy: myId || state.profile?.username || null,
    admins: myId ? [myId] : [],
    pinnedMsgId: null,
  };

  state.chats[localId] = localChat;
  try { await persistChatMeta(localId); } catch (_) {}

  // Best-effort server create
  let serverConv = null;
  try {
    if (typeof createConversation === 'function') {
      // Relax name check path: pass title as-is; createConversation may require >=3
      const nameForServer = title.length >= 3 ? title : (title + ' ·');
      serverConv = await createConversation(
        isChannel ? 'channel' : 'group',
        participants.length ? participants : (myId ? [myId] : []),
        nameForServer,
        description
      );
      if (serverConv && serverConv.id) {
        localChat.serverId = serverConv.id;
        if (typeof linkChatIds === 'function') linkChatIds(localId, serverConv.id);
        // Index under server id for realtime
        state.chats[serverConv.id] = {
          ...localChat,
          contactId: serverConv.id,
        };
        try { await persistChatMeta(serverConv.id); } catch (_) {}
        // Keep local alias pointing to same data
        state.chats[localId] = state.chats[serverConv.id];
      }
    }
  } catch (e) {
    console.warn('Server group/channel create failed, local chat kept', e);
  }

  // Reset form
  try {
    if (isChannel) {
      const cn = document.getElementById('channelName'); if (cn) cn.value = '';
      const ch = document.getElementById('channelHandle'); if (ch) ch.value = '';
      const cd = document.getElementById('channelDesc'); if (cd) cd.value = '';
      channelAvatarData = null;
    } else {
      const gn = document.getElementById('groupName'); if (gn) gn.value = '';
      const gd = document.getElementById('groupDesc'); if (gd) gd.value = '';
      window.groupMembers = [];
      pendingGroupMembers = [];
      groupAvatarData = null;
      try { renderGroupMemberChips(); } catch (_) {}
    }
  } catch (_) {}

  showToast(isChannel ? 'Канал создан!' : 'Группа создана!');
  try { renderChatList(); } catch (_) {}
  openChat(serverConv?.id || localId);
}

/* ========== OPEN CHAT ========== */
function openChat(id){
  if(state.currentChatId && state.currentChatId !== id){
    saveDraft();
    exitSelectMode();
  }
  state.currentChatId = id;
  const chat = state.chats[id];
  if(!chat) return;

  // Mark "read up to here" boundary: first unread incoming message
  state.readBoundaryId = null;
  if((chat.unread || 0) > 0 && Array.isArray(chat.messages) && chat.messages.length){
    let remaining = chat.unread;
    for(let i = chat.messages.length - 1; i >= 0 && remaining > 0; i--){
      if(!isMessageOut(chat.messages[i])){
        remaining--;
        if(remaining === 0) state.readBoundaryId = chat.messages[i].id;
      }
    }
  }

  chat.unread = 0;
  persistChatMeta(id);
  const contact = getContact(chat.contactId||id);
  document.getElementById('chatName').textContent = contact.name;
  if(chat.isChannel){
    document.getElementById('chatStatus').textContent = (chat.subscribers||1) + ' подписчик' + ((chat.subscribers||1)===1?'':(chat.subscribers||1)<5?'а':'ов');
  } else if(chat.isGroup){
    const cnt = (chat.members||[]).length || 1;
    document.getElementById('chatStatus').textContent = cnt + ' участник' + (cnt===1?'':cnt<5?'а':'ов');
  } else {
    document.getElementById('chatStatus').textContent = contact.online ? 'в сети' : 'был(а) недавно';
  }
  const av = document.getElementById('chatAvatar');
  av.className = 'avatar '+contact.gradient+' pressable';
  av.style.width='42px'; av.style.height='42px'; av.style.fontSize='14px';
  if(chat.avatar){ av.style.backgroundImage=`url(${chat.avatar})`; av.textContent=''; }
  else { av.style.backgroundImage=''; av.innerHTML = contact.initials + (contact.online && !chat.isChannel && !chat.isGroup ?'<span class="online-dot" style="width:10px;height:10px;"></span>':''); }

  // Calls only for 1:1 DMs — not for channels or groups
  const canCall = !chat.isChannel && !chat.isGroup;
  const audioBtn = document.getElementById('chatCallAudioBtn');
  const videoBtn = document.getElementById('chatCallVideoBtn');
  if(audioBtn) audioBtn.style.display = canCall ? '' : 'none';
  if(videoBtn) videoBtn.style.display = canCall ? '' : 'none';

  renderUserInfo(id);
  renderMessages();
  try{ applyChatWallpaper(); }catch(_){}
  renderPinnedBar();
  loadDraft(id);
  updateChannelInputState();
  go('chat');
  document.getElementById('app').classList.add('has-chat');
  if (window.innerWidth >= 768) document.getElementById('app').classList.add('desktop-chat');
  else document.getElementById('app').classList.remove('desktop-chat');
  try {
    if (typeof ChiperSync !== 'undefined' && ChiperSync.syncMessagesForChat) {
      ChiperSync.syncMessagesForChat(id, 50).then(() => {
        if (state.currentChatId === id && typeof renderMessages === 'function') renderMessages();
      }).catch(() => {});
    }
  } catch (_) {}

  if(navigator.vibrate) navigator.vibrate(8);
  if(chat.isChannel || chat.isGroup){
    loadConversationMessages(id).then(()=>{
      if(state.currentChatId === id){ renderMessages(); }
    }).catch(()=>{});
  } else if(!chat.isChannel && !chat.isGroup){
    loadRemoteChatMessages(id).then(()=>{
      if(state.currentChatId === id){ renderMessages(); }
    }).catch(()=>{});
  }
}

function renderUserInfo(chatId){
  const id = chatId || state.currentChatId;
  const chat = state.chats[id];
  if(!chat) return;
  const contact = getContact(chat.contactId||id);
  document.getElementById('userinfoName').textContent = contact.name;
  document.getElementById('userinfoUser').textContent = contact.username || chat.handle || '';
  document.getElementById('userinfoBio').textContent = contact.bio || chat.bio || '—';
  const uav = document.getElementById('userinfoAvatar');
  uav.className = 'avatar big-avatar '+contact.gradient;
  if(chat.avatar){ uav.style.backgroundImage=`url(${chat.avatar})`; uav.textContent=''; }
  else { uav.style.backgroundImage=''; uav.textContent = contact.initials; }

  const isCh = !!chat.isChannel;
  const isGr = !!chat.isGroup;
  document.getElementById('userinfoActionsUser').style.display = (!isCh && !isGr) ? 'flex' : 'none';
  document.getElementById('userinfoActionsChannel').style.display = isCh ? 'flex' : 'none';
  document.getElementById('userinfoActionsGroup').style.display = isGr ? 'flex' : 'none';
  document.getElementById('userinfoUserCards').style.display = (!isCh && !isGr) ? '' : 'none';
  document.getElementById('userinfoChannelCards').style.display = isCh ? '' : 'none';
  document.getElementById('userinfoGroupCards').style.display = isGr ? '' : 'none';

  if(isCh){
    document.getElementById('userinfoStat1Lbl').textContent = 'Подписчики';
    document.getElementById('userinfoChats').textContent = chat.subscribers || 1;
    document.getElementById('userinfoStat2Lbl').textContent = 'Постов';
    document.getElementById('userinfoMedia').textContent = (chat.messages||[]).length;
    document.getElementById('userinfoStat3Lbl').textContent = 'Тип';
    document.getElementById('userinfoSince').textContent = chat.isPublic !== false ? 'Публичный' : 'Приватный';
    document.getElementById('channelSubsCount').textContent = chat.subscribers || 1;
    document.getElementById('channelHandleView').textContent = chat.handle || contact.username || '';
    const subBtn = document.getElementById('subscribeBtn');
    if(subBtn){
      subBtn.textContent = chat.subscribed ? 'Отписаться' : 'Подписаться';
      subBtn.style.background = chat.subscribed ? '' : '';
      if(chat.subscribed){ subBtn.classList.remove('gradient-btn'); subBtn.classList.add('glass'); subBtn.style.color='var(--text)'; subBtn.style.height='46px'; subBtn.style.borderRadius='18px'; }
      else { subBtn.classList.add('gradient-btn'); subBtn.classList.remove('glass'); subBtn.style.color=''; subBtn.style.height=''; }
    }
    document.getElementById('userinfoDangerLabel').textContent = 'Покинуть канал';
    document.getElementById('membersSectionLabel').style.display = 'none';
    document.getElementById('membersList').style.display = 'none';
    // invite link card
    let inv = document.getElementById('inviteLinkCard');
    if(!inv){
      inv = document.createElement('div');
      inv.id = 'inviteLinkCard';
      inv.className = 'invite-box glass r20';
      const parent = document.getElementById('userinfoChannelCards') || document.getElementById('userinfo') || document.querySelector('#screen-userinfo .screen-scroll');
      if(parent) parent.appendChild(inv);
    }
    inv.style.display = '';
    inv.innerHTML = '<div class="k" style="font-size:12px;color:var(--text-secondary);">Ссылка-приглашение</div><code id="inviteLinkText"></code><button class="gradient-btn full-btn r20" style="margin-top:10px;height:40px;font-size:13px;" onclick="copyInviteLink()">Копировать</button>';
    const lt = document.getElementById('inviteLinkText');
    if(lt) lt.textContent = makeInviteLink(id);
  } else if(isGr){
    const members = chat.members || [];
    document.getElementById('userinfoStat1Lbl').textContent = 'Участники';
    document.getElementById('userinfoChats').textContent = members.length || 1;
    document.getElementById('userinfoStat2Lbl').textContent = 'Сообщений';
    document.getElementById('userinfoMedia').textContent = (chat.messages||[]).length;
    document.getElementById('userinfoStat3Lbl').textContent = 'Статус';
    document.getElementById('userinfoSince').textContent = chat.joined ? 'Вы в группе' : 'Не в группе';
    document.getElementById('groupMembersCount').textContent = members.length || 1;
    const joinBtn = document.getElementById('joinGroupBtn');
    if(joinBtn){
      joinBtn.textContent = chat.joined ? 'Выйти из группы' : 'Войти в группу';
    }
    document.getElementById('userinfoDangerLabel').textContent = 'Покинуть группу';
    let invG = document.getElementById('inviteLinkCard');
    if(!invG){
      invG = document.createElement('div');
      invG.id = 'inviteLinkCard';
      invG.className = 'invite-box glass r20';
      const parent = document.getElementById('userinfoGroupCards') || document.querySelector('#screen-userinfo .screen-scroll');
      if(parent) parent.appendChild(invG);
    }
    invG.style.display = '';
    invG.innerHTML = '<div class="k" style="font-size:12px;color:var(--text-secondary);">Ссылка-приглашение</div><code id="inviteLinkText"></code><button class="gradient-btn full-btn r20" style="margin-top:10px;height:40px;font-size:13px;" onclick="copyInviteLink()">Копировать</button>';
    const ltG = document.getElementById('inviteLinkText');
    if(ltG) ltG.textContent = makeInviteLink(id);
    // members list
    const mLabel = document.getElementById('membersSectionLabel');
    const mList = document.getElementById('membersList');
    mLabel.style.display = '';
    mList.style.display = '';
    mList.innerHTML = '';
    const me = getCurrentUserKey().replace(/^@/,'');
    const allMembers = members.length ? members : [me];
    allMembers.forEach((u, idx)=>{
      const un = String(u).replace(/^@/,'');
      const isMe = un.toLowerCase() === me.toLowerCase();
      const row = document.createElement('div');
      row.className = 'member-row glass r20';
      const initials = un.slice(0,2).toUpperCase();
      row.innerHTML = `<div class="avatar av-g${(idx%5)+1}" style="width:40px;height:40px;font-size:13px;">${escapeHtml(initials)}</div>
        <div><div class="name" style="font-size:14px;font-weight:700;">${escapeHtml(isMe?'Вы':'@'+un)}</div>
        <div class="sub" style="font-size:12px;color:var(--text-secondary);">${isMe?'вы':''}</div></div>
        <span class="role">${idx===0?'создатель':''}</span>`;
      mList.appendChild(row);
    });
  } else {
    document.getElementById('userinfoLogin').textContent = contact.username;
    document.getElementById('userinfoOnline').textContent = contact.online ? 'в сети' : 'был(а) недавно';
    document.getElementById('userinfoStat1Lbl').textContent = 'Общих';
    document.getElementById('userinfoChats').textContent = '1';
    document.getElementById('userinfoStat2Lbl').textContent = 'Медиа';
    let media=0; (chat.messages||[]).forEach(m=>{ if(m.type==='image'||m.type==='file'||m.type==='voice') media++; });
    document.getElementById('userinfoMedia').textContent = media;
    document.getElementById('userinfoStat3Lbl').textContent = 'В Chiper';
    document.getElementById('userinfoSince').textContent = '—';
    document.getElementById('userinfoDangerLabel').textContent = 'Заблокировать';
    document.getElementById('membersSectionLabel').style.display = 'none';
    document.getElementById('membersList').style.display = 'none';
    const inv = document.getElementById('inviteLinkCard');
    if(inv) inv.style.display = 'none';
  }
}

function toggleSubscribe(){
  const chat = state.chats[state.currentChatId];
  if(!chat || !chat.isChannel) return;
  chat.subscribed = !chat.subscribed;
  if(chat.subscribed) chat.subscribers = (chat.subscribers||0) + 1;
  else chat.subscribers = Math.max(0, (chat.subscribers||1) - 1);
  persistChatMeta(state.currentChatId);
  renderUserInfo();
  showToast(chat.subscribed ? 'Вы подписались' : 'Вы отписались');
}

function toggleJoinGroup(){
  const chat = state.chats[state.currentChatId];
  if(!chat || !chat.isGroup) return;
  chat.joined = !chat.joined;
  const me = getCurrentUserKey().replace(/^@/,'');
  if(!chat.members) chat.members = [];
  if(chat.joined && !chat.members.includes(me)) chat.members.push(me);
  if(!chat.joined) chat.members = chat.members.filter(m => m !== me && m !== '@'+me);
  persistChatMeta(state.currentChatId);
  renderUserInfo();
  openChat(state.currentChatId);
  showToast(chat.joined ? 'Вы вошли в группу' : 'Вы вышли из группы');
}

function formatMsgDate(ts){
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate()-1);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if(day.getTime() === today.getTime()) return 'Сегодня';
  if(day.getTime() === yesterday.getTime()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day:'numeric', month:'long', year: d.getFullYear()!==now.getFullYear() ? 'numeric' : undefined });
}

function renderMessages(){
  const box = document.getElementById('messages');
  box.innerHTML = '';
  const chat = state.chats[state.currentChatId];
  if(!chat) return;
  if(chat.messages.length === 0){
    box.innerHTML = `<div class="empty-state" style="padding:40px 20px;"><div class="emoji">👋</div><div class="title">Нет сообщений</div><div class="desc">Напишите первым — или прикрепите фото / голосовое</div></div>`;
    return;
  }
  const WINDOW = 200;
  const all = chat.messages;
  const start = Math.max(0, all.length - WINDOW);
  const slice = all.slice(start);
  const paint = ()=>{
    box.innerHTML = '';
    if(start > 0){
      const more = document.createElement('div');
      more.style.cssText = 'text-align:center;padding:10px;font-size:12px;color:var(--text-secondary);cursor:pointer;';
      more.textContent = '↑ Показать более ранние (' + start + ')';
      more.onclick = ()=>{
        const older = all.slice(0, start);
        let lastDate = null;
        older.forEach(m => {
          const ds = formatMsgDate(m.ts);
          if(ds !== lastDate){
            lastDate = ds;
            const sep = document.createElement('div');
            sep.className = 'msg-date-sep';
            sep.innerHTML = `<span>${ds}</span>`;
            box.insertBefore(sep, box.firstChild.nextSibling);
          }
          box.insertBefore(createBubbleEl(m), box.firstChild.nextSibling);
        });
        more.remove();
      };
      box.appendChild(more);
    }
    let lastDate = null;
    slice.forEach(m => {
      const ds = formatMsgDate(m.ts);
      if(ds !== lastDate){
        lastDate = ds;
        const sep = document.createElement('div');
        sep.className = 'msg-date-sep';
        sep.innerHTML = `<span>${ds}</span>`;
        box.appendChild(sep);
      }
      // "Прочитано досюда" — once, before the first previously-unread message
      if(state.readBoundaryId && m.id === state.readBoundaryId){
        const rs = document.createElement('div');
        rs.className = 'read-sep';
        rs.textContent = 'Прочитано досюда';
        box.appendChild(rs);
      }
      box.appendChild(createBubbleEl(m));
    });
    scrollMessagesToBottom();
  };
  if(all.length > 8){
    box.innerHTML = '<div class="skel-msg"></div><div class="skel-msg out"></div><div class="skel-msg"></div>';
    requestAnimationFrame(paint);
  } else {
    paint();
  }
}

function createBubbleEl(m){
  const b = document.createElement('div');
  const out = isMessageOut(m);
  b.className = 'bubble ' + (out ? 'out' : 'in glass') + ' r22 show' + (m.deleted ? ' deleted' : '');
  b.dataset.id = m.id;
  b.dataset.out = out ? '1' : '0';
  if(m.deleted){
    b.innerHTML = `<span class="bubble-text">Сообщение удалено</span><span class="time">${timeStr(m)}</span>`;
  } else if(m.type==='voice'){
    b.classList.add('voice-bubble');
    b.innerHTML = buildVoiceHTML(m);
    setupVoicePlayback(b, m);
  } else if(m.type==='image'){
    b.innerHTML = `<img class="media-preview" src="${m.data}" alt="Фото">${m.text?escapeHtml(m.text):''}<span class="time">${timeStr(m)}${statusTicks(m)}</span>`;
  } else if(m.type==='file'){
    b.innerHTML = `<div class="file-attach"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.fileName||'Файл')}</div></div><span class="time">${timeStr(m)}${statusTicks(m)}</span>`;
  } else {
    let html = '';
    if(m.replyTo){
      const orig = state.chats[state.currentChatId]?.messages.find(x=>x.id===m.replyTo);
      const replyName = orig ? (isMessageOut(orig)?'Вы':(getContact(state.chats[state.currentChatId]?.contactId)?.name||'…')) : '…';
      const replyPreview = orig?.deleted ? 'Сообщение удалено' : (orig?.text || (orig?.type==='voice'?'Голосовое':orig?.type==='image'?'Фото':'Медиа') || '…');
      html += `<div class="reply-quote"><b>${escapeHtml(replyName)}</b><br>${escapeHtml(String(replyPreview).slice(0,80))}</div>`;
    }
    html += `<span class="bubble-text">${escapeHtml(m.text||'')}</span>` + (m.edited?'<span class="edited-label">изм.</span>':'');
    html += `<span class="time">${timeStr(m)}${statusTicks(m)}</span>`;
    if(m.reactions && Object.keys(m.reactions).length){
      html += '<div class="reactions">'+Object.entries(m.reactions).map(([e,c])=>`<span class="reaction" data-e="${e}">${e} ${c>1?c:''}</span>`).join('')+'</div>';
    }
    b.innerHTML = html;
  }
  // select checkbox
  const check = document.createElement('div');
  check.className = 'sel-check';
  check.innerHTML = '✓';
  b.style.position = 'relative';
  b.appendChild(check);
  if(state.selectMode && state.selectedMsgs.has(m.id)) b.classList.add('selected-msg');

  // Gestures:
  //  • 1 tap  → меню действий (без удержания)
  //  • 2 taps → быстрая реакция ❤️ (из 10)
  //  • swipe  → ответ
  //  • long-press → режим выбора
  const DEFAULT_REACTION = '❤️';
  let tapTimer = null;
  let didSwipe = false;
  let lastTapAt = 0;

  function playReactPop(emoji){
    const pop = document.createElement('div');
    pop.textContent = emoji;
    pop.style.cssText = 'position:absolute;left:50%;top:40%;transform:translate(-50%,-50%) scale(0.4);font-size:36px;pointer-events:none;opacity:0;transition:transform 350ms ease,opacity 350ms ease;z-index:5;';
    b.appendChild(pop);
    requestAnimationFrame(()=>{
      pop.style.opacity = '1';
      pop.style.transform = 'translate(-50%,-80%) scale(1.25)';
    });
    setTimeout(()=>{ pop.style.opacity='0'; setTimeout(()=>pop.remove(), 280); }, 420);
  }

  function onBubbleTap(e){
    if(state.selectMode){
      toggleMsgSelect(m.id);
      return;
    }
    if(e.target.closest('.reaction')){
      toggleReaction(m.id, e.target.dataset.e);
      return;
    }
    if(e.target.closest('.voice-play, .voice-speed, button, a, input, textarea, .sel-check')) return;
    if(didSwipe) return;

    const now = Date.now();
    // Двойной тап за ~320мс → ❤️
    if(now - lastTapAt < 320){
      clearTimeout(tapTimer);
      tapTimer = null;
      lastTapAt = 0;
      if(!m.deleted){
        toggleReaction(m.id, DEFAULT_REACTION);
        playReactPop(DEFAULT_REACTION);
        if(navigator.vibrate) navigator.vibrate(12);
      }
      return;
    }
    lastTapAt = now;
    clearTimeout(tapTimer);
    // Одиночный тап → меню (короткая задержка, чтобы не конфликтовать с двойным тапом)
    tapTimer = setTimeout(()=>{
      tapTimer = null;
      showMsgCtx(e, m);
    }, 160);
  }

  b.addEventListener('pointerup', (e)=>{
    if(e.pointerType === 'touch' && didSwipe) return;
    if(e.button != null && e.button !== 0) return;
    onBubbleTap(e);
  });

  // Долгое нажатие → мультивыбор (не меню)
  setupLongPress(b, (e)=>{
    if(state.selectMode){ toggleMsgSelect(m.id); return; }
    clearTimeout(tapTimer);
    tapTimer = null;
    lastTapAt = 0;
    enterSelectMode(m.id);
  });

  // Свайп → ответ
  let startX=0, currentX=0, swiping=false;
  const replyIcon = document.createElement('div');
  replyIcon.className = 'swipe-reply-icon';
  replyIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 17l-5-5 5-5M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
  b.appendChild(replyIcon);
  b.addEventListener('touchstart', e=>{
    if(state.selectMode) return;
    startX = e.touches[0].clientX; currentX = startX; swiping = true; didSwipe = false;
    b.classList.add('swiping');
  }, {passive:true});
  b.addEventListener('touchmove', e=>{
    if(!swiping || state.selectMode) return;
    currentX = e.touches[0].clientX;
    const dx = Math.max(0, Math.min(80, currentX - startX));
    if(dx > 8) didSwipe = true;
    b.style.transform = `translateX(${dx}px)`;
    replyIcon.style.opacity = String(dx/60);
    replyIcon.style.transform = `translateY(-50%) scale(${0.6 + 0.4*(dx/60)})`;
  }, {passive:true});
  b.addEventListener('touchend', e=>{
    if(!swiping) return;
    swiping = false;
    b.classList.remove('swiping');
    const dx = currentX - startX;
    b.style.transform = '';
    replyIcon.style.opacity = '0';
    if(dx > 55 && !state.selectMode){
      didSwipe = true;
      clearTimeout(tapTimer);
      tapTimer = null;
      lastTapAt = 0;
      setReply(m);
      if(navigator.vibrate) navigator.vibrate(15);
    }
    setTimeout(()=>{ didSwipe = false; }, 80);
  }, {passive:true});
  return b;
}

function timeStr(m){
  const d = new Date(m.ts);
  return d.getHours()+':'+String(d.getMinutes()).padStart(2,'0');
}
function statusTicks(m){
  if(!isMessageOut(m)) return '';
  const s = m.status || 'sent';
  if(s==='pending') return '<span class="status-ticks"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></span>';
  if(s==='sent') return '<span class="status-ticks"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg></span>';
  if(s==='delivered') return '<span class="status-ticks"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L7 17l-5-5"/><path d="M22 6L11 17"/></svg></span>';
  // read - blue double
  return '<span class="status-ticks" style="color:#60A5FA"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L7 17l-5-5"/><path d="M22 6L11 17"/></svg></span>';
}

function buildVoiceHTML(m){
  const bars = (m.waveform||Array.from({length:24},()=>6+Math.random()*16)).map(h=>`<div class="bar" style="height:${h}px;"></div>`).join('');
  return `<button class="voice-play" aria-label="Воспроизвести"><svg viewBox="0 0 24 24" fill="#fff"><path class="playicon" d="M8 5v14l11-7z"/></svg></button>
    <div class="voice-wave">${bars}</div>
    <div class="voice-dur">${formatDur(m.duration||0)}</div>
    <span class="voice-speed" data-rate="1">1x</span>
    <span class="time" style="display:none">${timeStr(m)}${statusTicks(m)}</span>
    ${m.data?`<audio src="${m.data}" preload="metadata"></audio>`:''}`;
}

function setupVoicePlayback(wrap, m){
  const audio = wrap.querySelector('audio');
  if(!audio) return;
  const playBtn = wrap.querySelector('.voice-play');
  const playIcon = wrap.querySelector('.playicon');
  const bars = wrap.querySelectorAll('.voice-wave .bar');
  const durEl = wrap.querySelector('.voice-dur');
  const speedBtn = wrap.querySelector('.voice-speed');
  let rate = 1;
  speedBtn?.addEventListener('click', (e)=>{
    e.stopPropagation();
    rate = rate===1 ? 1.5 : rate===1.5 ? 2 : 1;
    audio.playbackRate = rate;
    speedBtn.textContent = rate+'x';
  });
  playBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    if(audio.paused){
      document.querySelectorAll('.voice-bubble audio').forEach(a=>{ if(a!==audio){ a.pause(); a.currentTime=0; }});
      audio.play();
      playIcon.setAttribute('d','M6 5h4v14H6zM14 5h4v14h-4z');
    } else {
      audio.pause();
      playIcon.setAttribute('d','M8 5v14l11-7z');
    }
  });
  audio.addEventListener('timeupdate', ()=>{
    if(!audio.duration) return;
    const progress = audio.currentTime / audio.duration;
    const activeCount = Math.floor(progress * bars.length);
    bars.forEach((b,i)=>{ b.style.background = i < activeCount ? '#fff' : 'rgba(255,255,255,0.35)'; });
    durEl.textContent = formatDur(Math.max(0, audio.duration - audio.currentTime));
  });
  audio.addEventListener('ended', ()=>{
    playIcon.setAttribute('d','M8 5v14l11-7z');
    bars.forEach(b=> b.style.background = 'rgba(255,255,255,0.35)');
    durEl.textContent = formatDur(m.duration||audio.duration);
  });
}

/* ========== SEND MESSAGE ========== */
function onTypeInput(){
  const val = document.getElementById('msgInput').value.trim();
  document.getElementById('micSendSwap').classList.toggle('has-text', val.length > 0);
  // BroadcastChannel typing
  if(bc) bc.postMessage({ type:'typing', chatId: state.currentChatId, from: state.profile.username });
}

async function sendMessage(){
  const input = document.getElementById('msgInput');
  if(!input) return;
  const text = input.value.trim();
  if(!text) return;
  const chatId = state.currentChatId;
  const chat = state.chats[chatId];
  if(!chat) return;
  if(!canPostInChat(chat)){ showToast('Нет прав на отправку'); return; }

  // Keep keyboard open / focus stable on mobile
  const keepFocus = () => {
    try {
      input.focus({ preventScroll: true });
    } catch(_) {
      try { input.focus(); } catch(__) {}
    }
  };

  const from = getCurrentUserKey();
  const msg = {
    id: uid(),
    type: 'text',
    text,
    from,
    out: true,
    ts: Date.now(),
    // Online → show as sent immediately (no "queue" feel). Offline → pending.
    status: (navigator.onLine === false) ? 'pending' : 'sent',
    replyTo: state.replyTo?.id || null,
  };

  // Clear input instantly and keep caret in the field
  input.value = '';
  onTypeInput();
  cancelReply();
  if(state.drafts) delete state.drafts[chatId];
  keepFocus();

  // Optimistic local bubble (do not await network before showing)
  try { await addMessage(chatId, msg); } catch(e){ console.warn('addMessage', e); }
  const el = createBubbleEl(msg);
  const box = document.getElementById('messages');
  if(box){
    box.appendChild(el);
    requestAnimationFrame(()=> el.classList.add('show'));
  }
  scrollMessagesToBottom(true);
  if(navigator.vibrate) navigator.vibrate(10);
  const live = document.getElementById('ariaLive');
  if(live) live.textContent = 'Сообщение отправлено';
  keepFocus();

  // Background delivery — never block the input
  const deliverInBackground = async () => {
    try {
      if(chat.isChannel || chat.isGroup){
        const serverConvId = (typeof resolveServerChatId === 'function' ? resolveServerChatId(chatId) : null)
          || chat.serverId || (typeof isUuid === 'function' && isUuid(chatId) ? chatId : null);
        const payload = {
          conversation_id: serverConvId || chatId,
          sender_id: (typeof getMyProfileId === 'function' ? getMyProfileId() : null) || state.profile?.id,
          content: text,
          message_type: 'text',
          _localMsgId: msg.id,
          _localChatId: chatId,
        };
        if (navigator.onLine === false) {
          if (typeof ChiperCore !== 'undefined' && ChiperCore.enqueueOutbox) {
            ChiperCore.enqueueOutbox({ type: 'message', payload });
          }
          msg.status = 'pending';
          updateBubbleStatus(msg);
          await updateMessage(chatId, msg.id, { status: 'pending' });
          return;
        }
        if (!payload.conversation_id || (typeof isUuid === 'function' && !isUuid(payload.conversation_id))) {
          // Local-only group without server id — keep as sent locally
          msg.status = 'sent';
          updateBubbleStatus(msg);
          return;
        }
        const res = await postJson('/api/messages', {
          conversation_id: payload.conversation_id,
          content: payload.content,
          message_type: payload.message_type,
          client_msg_id: msg.id,
        });
        if (res && res.message && res.message.id) {
          msg.serverId = res.message.id;
        }
        msg.status = 'delivered';
        updateBubbleStatus(msg);
        await updateMessage(chatId, msg.id, { status: 'delivered', serverId: msg.serverId });
      } else if(chat.contactId){
        if (navigator.onLine === false) {
          if (typeof ChiperCore !== 'undefined' && ChiperCore.enqueueOutbox) {
            ChiperCore.enqueueOutbox({ type: 'e2ee', chatId, msg });
          }
          msg.status = 'pending';
          updateBubbleStatus(msg);
          await updateMessage(chatId, msg.id, { status: 'pending' });
          return;
        }
        await encryptAndSendMessage(chatId, msg);
        msg.status = 'delivered';
        updateBubbleStatus(msg);
        await updateMessage(chatId, msg.id, { status: 'delivered' });
      } else {
        // Local / demo chat — mark delivered right away
        msg.status = 'delivered';
        updateBubbleStatus(msg);
        await updateMessage(chatId, msg.id, { status: 'delivered' });
      }
    } catch(e) {
      console.error('Send message failed', e);
      if (typeof ChiperCore !== 'undefined' && ChiperCore.enqueueOutbox) {
        const serverConvId = (typeof resolveServerChatId === 'function' ? resolveServerChatId(chatId) : null)
          || chat.serverId || chatId;
        ChiperCore.enqueueOutbox({
          type: chat.contactId ? 'e2ee' : 'message',
          chatId,
          msg,
          payload: {
            conversation_id: serverConvId,
            content: text,
            message_type: 'text',
            _localMsgId: msg.id,
            _localChatId: chatId,
          },
        });
        msg.status = 'pending';
        updateBubbleStatus(msg);
        await updateMessage(chatId, msg.id, { status: 'pending' });
        // Silent — already shown in UI; only toast if offline banner not enough
      } else {
        msg.status = 'failed';
        updateBubbleStatus(msg);
        await updateMessage(chatId, msg.id, { status: 'failed' });
        showToast('Не удалось отправить');
      }
    } finally {
      keepFocus();
    }
  };

  // Fire and forget — UI already updated
  deliverInBackground();
  keepFocus();
}

function updateBubbleStatus(m){
  const el = document.querySelector(`.bubble[data-id="${m.id}"]`);
  if(!el) return;
  const timeEl = el.querySelector('.time');
  if(timeEl) timeEl.innerHTML = timeStr(m) + statusTicks(m);
}

async function simulateReply(){
  const replies = ['Понял, жду 👍', 'Ок, гляну в течение часа', 'Супер, спасибо!', 'Хорошо, напишу как будет готово', 'Договорились 🙌', 'Класс 🔥'];
  const typing = document.createElement('div');
  typing.className = 'bubble in glass r22 typing-bubble';
  typing.id = 'typingInd';
  typing.innerHTML = '<span></span><span></span><span></span>';
  document.getElementById('messages').appendChild(typing);
  scrollMessagesToBottom();
  document.getElementById('chatStatus').textContent = 'печатает…';
  if(bc) bc.postMessage({ type:'typing', chatId: state.currentChatId });

  setTimeout(async ()=>{
    typing.remove();
    document.getElementById('chatStatus').textContent = 'в сети';
    const chat = state.chats[state.currentChatId];
    if(!chat) return;
    const msg = {
      id: uid(), type:'text', text: replies[Math.floor(Math.random()*replies.length)],
      out:false, ts:Date.now(), status:'read'
    };
    await addMessage(state.currentChatId, msg);
    const el = createBubbleEl(msg);
    document.getElementById('messages').appendChild(el);
    requestAnimationFrame(()=> el.classList.add('show'));
    scrollMessagesToBottom();
  }, 1400 + Math.random()*800);
}

/* ========== REPLY / REACTIONS / EDIT / DELETE ========== */
function setReply(m){
  state.replyTo = m;
  document.getElementById('replyBar').classList.add('active');
  document.getElementById('replyName').textContent = isMessageOut(m) ? 'Вы' : getContact(state.chats[state.currentChatId]?.contactId).name;
  document.getElementById('replyText').textContent = m.text || (m.type==='voice'?'Голосовое':m.type==='image'?'Фото':'Медиа');
  try {
    document.getElementById('msgInput').focus({ preventScroll: true });
  } catch(_) {
    document.getElementById('msgInput').focus();
  }
}
function cancelReply(){
  state.replyTo = null;
  document.getElementById('replyBar').classList.remove('active');
}

function toggleReaction(msgId, emoji){
  const chat = state.chats[state.currentChatId];
  const m = chat?.messages.find(x=>x.id===msgId);
  if(!m || m.deleted) return;
  if(!m.reactions) m.reactions = {};
  // Toggle: second double-tap / click removes the same reaction
  const removing = !!m.reactions[emoji];
  if(removing){
    delete m.reactions[emoji];
  } else {
    m.reactions[emoji] = 1;
  }
  updateMessage(state.currentChatId, msgId, { reactions: m.reactions });
  // Soft re-render only this bubble if possible
  const el = document.querySelector(`.bubble[data-id="${msgId}"]`);
  if(el && el.parentNode){
    const fresh = createBubbleEl(m);
    el.replaceWith(fresh);
  } else {
    renderMessages();
  }
  // Sync with server (fire-and-forget)
  if (!removing && typeof addReaction === 'function') {
    addReaction(msgId, emoji).catch((err) => console.warn('addReaction failed', err));
  }
}

async function deleteMsg(msgId){
  const chatId = state.currentChatId;
  const chat = state.chats[chatId];
  const m = chat?.messages.find(x=>x.id===msgId);
  // Soft-delete for own messages (keeps placeholder), hard-remove for others / media
  if(m && isMessageOut(m) && m.type==='text'){
    await updateMessage(chatId, msgId, { text: 'Сообщение удалено', deleted: true, type: 'text' });
  } else {
    await removeMessage(chatId, msgId);
  }
  renderMessages();
  showToast('Сообщение удалено');
}

async function editMsg(msgId){
  const chatId = state.currentChatId;
  const chat = state.chats[chatId];
  const m = chat?.messages.find(x=>x.id===msgId);
  if(!m || m.type!=='text' || !isMessageOut(m) || m.deleted) return;

  // Inline edit: replace bubble content with textarea
  const el = document.querySelector(`.bubble[data-id="${msgId}"]`);
  if(!el) {
    const newText = prompt('Редактировать:', m.text);
    if(newText!==null && newText.trim() && newText.trim() !== m.text){
      await updateMessage(chatId, msgId, { text: newText.trim(), edited: true });
      renderMessages();
      showToast('Изменено');
    }
    return;
  }

  const oldHtml = el.innerHTML;
  el.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.value = m.text || '';
  ta.style.cssText = 'width:100%;min-height:60px;border:none;border-radius:12px;padding:8px 10px;font:inherit;resize:vertical;background:rgba(0,0,0,0.15);color:inherit;outline:none;';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;margin-top:8px;justify-content:flex-end;';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Отмена';
  cancelBtn.className = 'pressable';
  cancelBtn.style.cssText = 'padding:6px 12px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer;font-size:13px;';
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Сохранить';
  saveBtn.className = 'pressable';
  saveBtn.style.cssText = 'padding:6px 14px;border-radius:10px;border:none;background:var(--primary);color:#fff;cursor:pointer;font-size:13px;font-weight:600;';
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  el.appendChild(ta);
  el.appendChild(actions);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const finish = async (save) => {
    if(save){
      const newText = ta.value.trim();
      if(newText && newText !== m.text){
        await updateMessage(chatId, msgId, { text: newText, edited: true });
        showToast('Изменено');
      }
    }
    renderMessages();
  };
  cancelBtn.onclick = (e)=>{ e.stopPropagation(); finish(false); };
  saveBtn.onclick = (e)=>{ e.stopPropagation(); finish(true); };
  ta.onkeydown = (e)=>{
    if(e.key === 'Escape'){ e.preventDefault(); finish(false); }
    if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); finish(true); }
  };
}

function forwardMsg(m){
  const targets = Object.keys(state.chats).filter(id => id !== state.currentChatId);
  if(!targets.length){ showToast('Нет других чатов'); return; }
  const items = targets.map(id => {
    const c = getContact(state.chats[id].contactId || id);
    return {
      label: c.name,
      icon: '↪',
      action: () => {
        const copy = { ...m, id: uid(), from: getCurrentUserKey(), out: true, ts: Date.now(), status: 'sent', replyTo: null };
        addMessage(id, copy).then(() => showToast('Переслано → ' + c.name));
      }
    };
  });
  openSheet(items);
}

/* ========== MULTI-SELECT ========== */
function enterSelectMode(initialId){
  state.selectMode = true;
  state.selectedMsgs = new Set();
  if(initialId) state.selectedMsgs.add(initialId);
  document.body.classList.add('select-mode');
  updateSelectUI();
  // refresh bubbles to show checkmarks
  document.querySelectorAll('#messages .bubble').forEach(b=>{
    if(state.selectedMsgs.has(b.dataset.id)) b.classList.add('selected-msg');
  });
}
function exitSelectMode(){
  state.selectMode = false;
  state.selectedMsgs = new Set();
  document.body.classList.remove('select-mode');
  document.querySelectorAll('.bubble.selected-msg').forEach(b=>b.classList.remove('selected-msg'));
  updateSelectUI();
}
function toggleMsgSelect(msgId){
  if(!state.selectMode) return;
  if(state.selectedMsgs.has(msgId)) state.selectedMsgs.delete(msgId);
  else state.selectedMsgs.add(msgId);
  const el = document.querySelector(`.bubble[data-id="${msgId}"]`);
  if(el) el.classList.toggle('selected-msg', state.selectedMsgs.has(msgId));
  updateSelectUI();
  if(state.selectedMsgs.size === 0) exitSelectMode();
}
function updateSelectUI(){
  const n = state.selectedMsgs?.size || 0;
  const el = document.getElementById('selCount');
  if(el) el.textContent = n + ' выбрано';
}
function selectAllVisible(){
  document.querySelectorAll('#messages .bubble').forEach(b=>{
    if(b.dataset.id){
      state.selectedMsgs.add(b.dataset.id);
      b.classList.add('selected-msg');
    }
  });
  updateSelectUI();
}
async function batchDelete(){
  const ids = [...state.selectedMsgs];
  if(!ids.length) return;
  if(!confirm(`Удалить ${ids.length} сообщ.?`)) return;
  for(const id of ids) await deleteMsg(id);
  exitSelectMode();
  showToast('Удалено: ' + ids.length);
}
function batchCopy(){
  const chat = state.chats[state.currentChatId];
  if(!chat) return;
  const texts = [...state.selectedMsgs].map(id=>{
    const m = chat.messages.find(x=>x.id===id);
    return m && !m.deleted ? (m.text || formatLast(m)) : null;
  }).filter(Boolean);
  if(!texts.length){ showToast('Нечего копировать'); return; }
  navigator.clipboard?.writeText(texts.join('\n')).then(()=>showToast('Скопировано: '+texts.length)).catch(()=>showToast('Ошибка копирования'));
}
function batchForward(){
  const chat = state.chats[state.currentChatId];
  if(!chat) return;
  const msgs = [...state.selectedMsgs].map(id => chat.messages.find(x=>x.id===id)).filter(Boolean);
  if(!msgs.length) return;
  const targets = Object.keys(state.chats).filter(id => id !== state.currentChatId);
  if(!targets.length){ showToast('Нет других чатов'); return; }
  const items = targets.map(id => {
    const c = getContact(state.chats[id].contactId || id);
    return {
      label: c.name,
      icon: '↪',
      action: async () => {
        for(const m of msgs){
          const copy = { ...m, id: uid(), from: getCurrentUserKey(), out: true, ts: Date.now(), status: 'sent', replyTo: null, deleted: false };
          await addMessage(id, copy);
        }
        showToast('Переслано → ' + c.name);
        exitSelectMode();
      }
    };
  });
  openSheet(items);
}

/* ========== CONTEXT MENUS ========== */
let longPressed = false;
function setupLongPress(el, cb){
  let timer, startX, startY;
  const start = (e)=>{
    longPressed = false;
    const pt = e.touches?e.touches[0]:e;
    startX = pt.clientX; startY = pt.clientY;
    timer = setTimeout(()=>{ longPressed=true; cb(e); if(navigator.vibrate) navigator.vibrate(20); }, 450);
  };
  const cancel = (e)=>{
    clearTimeout(timer);
    if(e.changedTouches){
      const dx = Math.abs(e.changedTouches[0].clientX-startX);
      const dy = Math.abs(e.changedTouches[0].clientY-startY);
      if(dx>12||dy>12) longPressed=true; // prevent click
    }
  };
  el.addEventListener('touchstart', start, {passive:true});
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchmove', ()=>clearTimeout(timer), {passive:true});
  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', ()=>clearTimeout(timer));
}

function showMsgCtx(e, m){
  const menu = document.getElementById('ctxMenu');
  const items = [];
  if(m.deleted){
    items.push({ label:'Удалить у себя', icon:'🗑', danger:true, action:()=>deleteMsg(m.id) });
  } else {
    items.push({ label:'Ответить', icon:'↩', action:()=>setReply(m) });
    items.push({ label:'Реакция', icon:'😊', action:()=>showReactions(e, m) });
    if(m.type==='text' && m.text){
      items.push({ label:'Копировать', icon:'📋', action:()=>{
        navigator.clipboard?.writeText(m.text).then(()=>showToast('Скопировано')).catch(()=>showToast('Не удалось скопировать'));
      }});
    }
    if(isMessageOut(m) && m.type==='text') items.push({ label:'Изменить', icon:'✎', action:()=>editMsg(m.id) });
    items.push({ label:'Переслать', icon:'↪', action:()=>forwardMsg(m) });
    const chPin = state.chats[state.currentChatId];
    if(chPin && (chPin.isChannel || chPin.isGroup) && canPostInChat(chPin)){
      if(chPin.pinnedMsgId === m.id) items.push({ label:'Открепить', icon:'📌', action:()=>unpinMessage() });
      else items.push({ label:'Закрепить', icon:'📌', action:()=>pinMessage(m.id) });
    }
    items.push({ label:'Удалить', icon:'🗑', danger:true, action:()=>deleteMsg(m.id) });
  }
  menu.innerHTML = items.map(it=>`<div class="ctx-item ${it.danger?'danger':''}" role="menuitem">${it.icon} ${it.label}</div>`).join('');
  menu.querySelectorAll('.ctx-item').forEach((el,i)=>{
    el.onclick = ()=>{ items[i].action(); hideCtx(); };
  });
  positionMenu(menu, e);
  menu.classList.add('show');
}

function showChatCtx(e, chatId){
  const menu = document.getElementById('ctxMenu');
  const chat = state.chats[chatId];
  const items = [
    { label: chat.pinned?'Открепить':'Закрепить', action:()=>{ chat.pinned=!chat.pinned; persistChatMeta(chatId); renderChatList(); } },
    { label: chat.muted?'Включить уведомления':'Без уведомлений', action:()=>{ chat.muted=!chat.muted; persistChatMeta(chatId); renderChatList(); showToast(chat.muted?'Без уведомлений':'Уведомления вкл.'); } },
    { label: chat.archived?'Разархивировать':'Архивировать', action:()=>{ chat.archived=!chat.archived; persistChatMeta(chatId); renderChatList(); go('chats'); } },
    { label:'Удалить чат', danger:true, action:()=>{ (async()=>{ delete state.chats[chatId]; try{ if(db){ await idbDelete('chats', chatId); const msgs=await idbGetAll('messages','chatId',chatId); for(const m of msgs){ if(m.mediaId) await idbDelete('media', m.mediaId); await idbDelete('messages', m.id); } } }catch(_){} renderChatList(); })(); } },
  ];
  menu.innerHTML = items.map(it=>`<div class="ctx-item ${it.danger?'danger':''}" role="menuitem">${it.label}</div>`).join('');
  menu.querySelectorAll('.ctx-item').forEach((el,i)=>{
    el.onclick = ()=>{ items[i].action(); hideCtx(); };
  });
  positionMenu(menu, e);
  menu.classList.add('show');
}

function positionMenu(menu, e){
  const pt = e.touches?e.touches[0]:e.changedTouches?e.changedTouches[0]:e;
  let x = pt.clientX, y = pt.clientY;
  menu.style.left = Math.min(x, window.innerWidth-220)+'px';
  menu.style.top = Math.min(y, window.innerHeight-200)+'px';
}
function hideCtx(){ document.getElementById('ctxMenu').classList.remove('show'); }
function hideReactions(){ document.getElementById('reactionPicker').classList.remove('show'); }
document.addEventListener('click', (e)=>{
  if(!e.target.closest('#ctxMenu') && !e.target.closest('#reactionPicker')){ hideCtx(); hideReactions(); }
});

function showReactions(e, m){
  hideCtx();
  const picker = document.getElementById('reactionPicker');
  // 10 reactions, ❤️ first (default for double-tap)
  const emojis = ['❤️','👍','😂','😮','😢','🔥','👏','🎉','💯','🤔'];
  picker.innerHTML = emojis.map(em=>`<span data-e="${em}">${em}</span>`).join('');
  picker.querySelectorAll('span').forEach(s=>{
    s.onclick = ()=>{ toggleReaction(m.id, s.dataset.e); hideReactions(); };
  });
  const pt = e.touches?e.touches[0]:e.changedTouches?e.changedTouches[0]:e;
  const x = pt?.clientX ?? window.innerWidth/2;
  const y = pt?.clientY ?? window.innerHeight/2;
  picker.style.left = Math.min(Math.max(8, x-100), window.innerWidth-240)+'px';
  picker.style.top = Math.max(y-70, 16)+'px';
  picker.classList.add('show');
}

/* ========== FILE ATTACH ========== */
async function handleFileAttach(input){
  const file = input.files[0];
  if(!file) return;
  const chat = state.chats[state.currentChatId];
  if(!chat) return;
  if(!canPostInChat(chat)){ showToast('Нет прав на отправку'); input.value=''; return; }
  const maxMb = isPremium() ? PRO_MAX_FILE_MB : FREE_MAX_FILE_MB;
  if(file.size > maxMb * 1024 * 1024){
    showToast('Лимит ' + maxMb + ' МБ' + (isPremium()?'':' · Premium: 25 МБ'));
    if(!isPremium()) go('premium');
    input.value='';
    return;
  }
  const reader = new FileReader();
  reader.onload = async (e)=>{
    const isImg = file.type.startsWith('image/');
    const msg = {
      id: uid(),
      type: isImg ? 'image' : 'file',
      data: e.target.result,
      fileName: file.name,
      from: getCurrentUserKey(),
      out: true,
      ts: Date.now(),
      status: 'sent',
    };
    await addMessage(state.currentChatId, msg);
    const el = createBubbleEl(msg);
    document.getElementById('messages').appendChild(el);
    requestAnimationFrame(()=> el.classList.add('show'));
    scrollMessagesToBottom();
    showToast(isImg?'Фото отправлено':'Файл отправлен');
  };
  reader.readAsDataURL(file);
  input.value = '';
}

/* ========== VOICE RECORDING ========== */
let mediaRecorder=null, recordedChunks=[], recordStartTime=0, recTimerInt=null, currentStream=null, recCancelled=false;
let recStartX=0, slideCancel=false;

function buildLiveWaveBars(){
  const wave = document.getElementById('recWave');
  wave.innerHTML = '';
  for(let i=0;i<28;i++){
    const b = document.createElement('div');
    b.className = 'b';
    b.style.height = '6px';
    wave.appendChild(b);
  }
}

async function startRecording(e){
  if(e) e.preventDefault();
  if(mediaRecorder && mediaRecorder.state==='recording') return;
  recCancelled = false;
  slideCancel = false;
  recStartX = e?.clientX || e?.touches?.[0]?.clientX || 0;
  try{
    currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }catch(err){
    showModal('Нет доступа к микрофону','Разрешите доступ к микрофону в настройках браузера, чтобы записывать голосовые сообщения.');
    return;
  }
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(currentStream);
  mediaRecorder.ondataavailable = (ev)=>{ if(ev.data.size>0) recordedChunks.push(ev.data); };
  mediaRecorder.onstop = onRecordingStop;
  mediaRecorder.start();
  recordStartTime = Date.now();

  document.getElementById('inputBar').style.display = 'none';
  document.getElementById('recordingBar').classList.add('active');
  document.getElementById('micSendSwap').classList.add('recording');
  document.getElementById('recHint').classList.add('show');
  buildLiveWaveBars();
  if(navigator.vibrate) navigator.vibrate(15);

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(currentStream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  source.connect(analyser);
  const dataArr = new Uint8Array(analyser.frequencyBinCount);
  const bars = document.querySelectorAll('#recWave .b');
  let last = 0;
  function tickWave(ts){
    if(!mediaRecorder || mediaRecorder.state!=='recording') return;
    if(ts - last > 50){ // throttle ~20fps
      analyser.getByteFrequencyData(dataArr);
      bars.forEach((bar,i)=>{
        const v = dataArr[i % dataArr.length] || 0;
        bar.style.height = Math.max(4, (v/255)*26) + 'px';
      });
      last = ts;
    }
    requestAnimationFrame(tickWave);
  }
  requestAnimationFrame(tickWave);

  recTimerInt = setInterval(()=>{
    const secs = Math.floor((Date.now()-recordStartTime)/1000);
    document.getElementById('recTimer').textContent = Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0');
  }, 250);
  mediaRecorder._audioCtx = audioCtx;
}

function onRecPointerMove(e){
  if(!mediaRecorder || mediaRecorder.state!=='recording') return;
  const x = e.clientX || e.touches?.[0]?.clientX || 0;
  if(recStartX - x > 80){
    slideCancel = true;
    document.getElementById('recHint').textContent = 'Отпустите для отмены';
    document.getElementById('recHint').style.color = 'var(--danger)';
  } else {
    slideCancel = false;
    document.getElementById('recHint').textContent = '← Свайп влево для отмены';
    document.getElementById('recHint').style.color = '';
  }
}
function onRecPointerLeave(){ /* keep recording until up */ }

function stopRecording(){
  if(!mediaRecorder || mediaRecorder.state!=='recording') return;
  if(slideCancel){ recCancelled = true; }
  mediaRecorder.stop();
}
function cancelRecording(){
  if(mediaRecorder && mediaRecorder.state==='recording'){
    recCancelled = true;
    mediaRecorder.stop();
  }
}
function onRecordingStop(){
  clearInterval(recTimerInt);
  const duration = (Date.now()-recordStartTime)/1000;
  if(currentStream) currentStream.getTracks().forEach(t=>t.stop());
  if(mediaRecorder?._audioCtx) mediaRecorder._audioCtx.close();
  document.getElementById('recordingBar').classList.remove('active');
  document.getElementById('inputBar').style.display = 'flex';
  document.getElementById('micSendSwap').classList.remove('recording');
  document.getElementById('recHint').classList.remove('show');
  document.getElementById('recHint').textContent = '← Свайп влево для отмены';
  document.getElementById('recHint').style.color = '';

  if(recCancelled || duration < 0.4){ recCancelled=false; showToast('Запись отменена'); return; }

  const blob = new Blob(recordedChunks, { type:'audio/webm' });
  const reader = new FileReader();
  reader.onload = async ()=>{
    const dataUrl = reader.result;
    // try real waveform
    let waveform = null;
    try{
      const ctx = new (window.AudioContext||window.webkitAudioContext)();
      const ab = await (await fetch(dataUrl)).arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      const ch = buf.getChannelData(0);
      const step = Math.floor(ch.length / 24);
      waveform = [];
      for(let i=0;i<24;i++){
        let sum=0;
        for(let j=0;j<step;j++) sum += Math.abs(ch[i*step+j]||0);
        waveform.push(Math.max(4, Math.min(22, (sum/step)*40)));
      }
      ctx.close();
    }catch(_){}
    const chat = state.chats[state.currentChatId];
    if(!chat) return;
    const msg = {
      id: uid(), type:'voice', data: dataUrl, duration, waveform,
      from: getCurrentUserKey(), out:true, ts:Date.now(), status:'sent'
    };
    await addMessage(state.currentChatId, msg);
    const el = createBubbleEl(msg);
    document.getElementById('messages').appendChild(el);
    requestAnimationFrame(()=> el.classList.add('show'));
    scrollMessagesToBottom();
  };
  reader.readAsDataURL(blob);
}

function formatDur(s){
  s = Math.round(s);
  return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}

/* ========== PROFILE ========== */
function setProfileTab(tab, btn){
  document.querySelectorAll('#profileTabs .ptab').forEach(t => t.classList.remove('active'));
  if(btn) btn.classList.add('active');
  const content = document.getElementById('profileTabContent');
  if(!content) return;
  if(tab === 'gifts'){
    content.innerHTML = `<div class="empty-state" style="padding:28px 12px;"><div class="emoji">🎁</div><div class="title">Подарков пока нет</div><div class="desc">Скоро здесь появятся подарки</div></div>`;
  } else if(tab === 'archive'){
    content.innerHTML = `<div class="empty-state" style="padding:28px 12px;"><div class="emoji">🗂</div><div class="title">Архив пуст</div><div class="desc">Архив публикаций</div></div>`;
  } else {
    content.innerHTML = `<div class="empty-state" style="padding:28px 12px;"><div class="emoji">📭</div><div class="title">Пока пусто</div><div class="desc">Публикации появятся здесь</div></div>`;
  }
}

function renderProfile(){
  const p = state.profile || {};
  const nameEl = document.getElementById('profileNameView');
  if(nameEl){
    nameEl.innerHTML = escapeHtml(p.name || 'Пользователь') + (typeof profileBadgesHTML==='function' ? profileBadgesHTML() : (isPremium() ? ' <span class="premium-badge">PRO</span>' : ''));
  }
  try{ renderAvatarGallery(); }catch(_){}
  const userView = document.getElementById('profileUserView');
  if(userView) userView.textContent = p.username ? (p.username.startsWith('@') ? p.username : '@' + p.username) : '@user';
  let bioText = p.bio || '';
  if(isPremium() && p.customStatus) bioText = (p.customStatus ? '«' + p.customStatus + '» · ' : '') + bioText;
  const bioView = document.getElementById('profileBioView');
  if(bioView) bioView.textContent = bioText || 'Привет! Я в Chiper 👋';
  const infoLogin = document.getElementById('infoLogin');
  if(infoLogin) infoLogin.textContent = p.username || '@user';
  const miniName = document.getElementById('miniName');
  if(miniName) miniName.textContent = p.name || 'Пользователь';
  const miniUser = document.getElementById('miniUsername');
  if(miniUser) miniUser.textContent = p.username || '@user';

  // Phone
  const phoneRow = document.getElementById('infoPhoneRow');
  const phoneVal = document.getElementById('infoPhone');
  if(phoneRow && phoneVal){
    if(p.phone){ phoneRow.style.display = ''; phoneVal.textContent = p.phone; }
    else phoneRow.style.display = 'none';
  }

  // Birthday
  const bCard = document.getElementById('infoBirthdayCard');
  const bVal = document.getElementById('infoBirthday');
  if(bCard && bVal){
    if(p.birthday){
      bCard.style.display = '';
      try{
        const d = new Date(p.birthday + 'T00:00:00');
        const age = Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000));
        const dateStr = d.toLocaleDateString('ru-RU', { day:'numeric', month:'short', year:'numeric' });
        bVal.textContent = age > 0 && age < 120 ? (dateStr + ' (' + age + ' лет)') : dateStr;
      }catch(_){ bVal.textContent = p.birthday; }
    } else { bCard.style.display = 'none'; }
  }

  // City
  const cCard = document.getElementById('infoCityCard');
  const cVal = document.getElementById('infoCity');
  if(cCard && cVal){
    if(p.city){ cCard.style.display = ''; cVal.textContent = p.city; }
    else cCard.style.display = 'none';
  }

  // Presence
  const presence = document.getElementById('infoPresence');
  if(presence) presence.innerHTML = '<span class="online-shield">🛡</span> в сети';

  // Music card (optional custom status as track)
  const musicCard = document.getElementById('profileMusicCard');
  if(musicCard){
    if(p.customStatus || p.musicTitle){
      musicCard.style.display = 'flex';
      const t = document.getElementById('pmcTitle');
      const a = document.getElementById('pmcArtist');
      const al = document.getElementById('pmcAlbum');
      if(t) t.textContent = p.musicTitle || p.customStatus || '—';
      if(a) a.textContent = p.musicArtist || 'Chiper';
      if(al) al.textContent = p.musicAlbum || '';
    } else {
      musicCard.style.display = 'none';
    }
  }

  const extra = document.getElementById('profileExtraInfo');
  if(extra){
    const chips = [];
    if(p.gender){
      const gMap = { male:'♂ Мужской', female:'♀ Женский', other:'Другой' };
      chips.push(gMap[p.gender] || p.gender);
    }
    if(p.website) chips.push('🔗 ' + p.website.replace(/^https?:\/\//,''));
    extra.innerHTML = chips.map(c => `<span style="font-size:12px;padding:4px 10px;border-radius:999px;background:var(--glass);color:var(--text-secondary);">${escapeHtml(c)}</span>`).join('');
  }

  setAvatarContent(document.getElementById('bigAvatar'), p);
  setAvatarContent(document.getElementById('miniAvatar'), p);
  setAvatarContent(document.getElementById('drawerAvatar'), p);
  setAvatarContent(document.getElementById('chatsTopAvatar'), p);
  setAvatarContent(document.getElementById('navProfileAvatar'), p);
  const topName = document.getElementById('chatsTopName');
  if(topName) topName.textContent = p.username ? p.username.replace(/^@/,'') : (p.name || 'Chiper');
  if(p.banner){
    const ban = document.getElementById('profileBanner');
    if(ban){
      ban.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.25),rgba(0,0,0,0.35)), url(${p.banner})`;
      ban.style.backgroundSize = 'cover';
      ban.style.backgroundPosition = 'center';
    }
  }
  const sc = document.getElementById('statChats');
  if(sc) sc.textContent = Object.keys(state.chats||{}).length;
  let media=0, groups=0;
  Object.values(state.chats||{}).forEach(c=>{
    if(c.isGroup || c.isChannel) groups++;
    (c.messages||[]).forEach(m=>{ if(m.type==='image'||m.type==='file'||m.type==='voice') media++; });
  });
  const sm = document.getElementById('statMedia');
  if(sm) sm.textContent = media;
  const sg = document.getElementById('statGroups');
  if(sg) sg.textContent = groups;
  applyBubbleStyle();
}

function fillProfileEditForm(){
  const p = state.profile || {};
  const set = (id, v)=>{ const el=document.getElementById(id); if(el) el.value = v || ''; };
  set('editName', p.name);
  set('editUser', p.username);
  set('editBio', p.bio);
  set('editBirthday', p.birthday);
  set('editCity', p.city);
  set('editPhone', p.phone);
  set('editWebsite', p.website);
  const g = document.getElementById('editGender');
  if(g) g.value = p.gender || '';
  const err = document.getElementById('profileEditError');
  if(err){ err.classList.remove('show'); err.textContent=''; }
}

async function saveProfileEdit(){
  try{
    if(!state.profile) state.profile = {};
    const newName = (document.getElementById('editName')?.value || '').trim() || state.profile.name || 'Пользователь';
    let newUser = (document.getElementById('editUser')?.value || '').trim() || state.profile.username || '@user';
    if(!newUser.startsWith('@')) newUser = '@' + newUser;
    newUser = normalizeUsername(newUser);
    const err = document.getElementById('profileEditError');
    if(newUser.length < 3 || !/^@[a-z0-9._]{2,31}$/i.test(newUser)){
      if(err){ err.textContent = 'Некорректный username'; err.classList.add('show'); }
      showToast('Некорректный username');
      return;
    }
    if(normalizeUsername(newUser) !== normalizeUsername(state.profile.username||'')){
      const taken = await isUsernameTaken(newUser, state.profile.uid);
      if(taken){
        if(err){ err.textContent = 'Этот @username уже занят'; err.classList.add('show'); }
        showToast('Этот @username уже занят');
        return;
      }
    }
    state.profile.name = newName;
    state.profile.username = newUser;
    state.profile.bio = (document.getElementById('editBio')?.value || '').trim();
    state.profile.birthday = (document.getElementById('editBirthday')?.value || '').trim();
    state.profile.city = (document.getElementById('editCity')?.value || '').trim();
    state.profile.phone = (document.getElementById('editPhone')?.value || '').trim();
    state.profile.website = (document.getElementById('editWebsite')?.value || '').trim();
    state.profile.gender = document.getElementById('editGender')?.value || '';
    await persistProfileToAccounts();
    if(state.profile.email){
      await prepareCurrentUserProfile().catch((err)=>{
        console.warn('prepareCurrentUserProfile failed', err);
      });
      await saveProfileToServer(state.profile).catch((err) => {
        console.warn('remote saveProfileEdit failed', err);
      });
    }
    if(typeof renderProfile === 'function') renderProfile();
    showToast('Профиль сохранён ✓');
    go('profile');
  }catch(e){
    console.error('saveProfileEdit', e);
    showToast('Ошибка сохранения');
  }
}

const BUBBLE_STYLES = [
  { id:0, name:'Классика', bg:'linear-gradient(135deg,#7C3AED,#9333EA)' },
  { id:1, name:'Мягкий', bg:'linear-gradient(135deg,#7C3AED,#A855F7)' },
  { id:2, name:'Острый', bg:'linear-gradient(160deg,#6D28D9,#A855F7)' },
  { id:3, name:'Закат', bg:'linear-gradient(135deg,#F59E0B,#EF4444)' },
  { id:4, name:'Океан', bg:'linear-gradient(135deg,#06B6D4,#3B82F6)' },
  { id:5, name:'Неон', bg:'linear-gradient(135deg,#EC4899,#8B5CF6)' },
  { id:6, name:'Стекло', bg:'linear-gradient(135deg,#334155,#475569)' },
  { id:7, name:'Свечение', bg:'linear-gradient(135deg,#8B5CF6,#D946EF)' },
  { id:8, name:'Мята', bg:'linear-gradient(135deg,#10B981,#059669)' },
  { id:9, name:'Тёмный', bg:'linear-gradient(135deg,#1a1a2e,#16213e)' },
];

const BUBBLE_STYLE_VARS = {
  0: { bg:'linear-gradient(135deg, var(--primary), var(--accent))', shadow:'0 6px 20px color-mix(in srgb, var(--primary) 30%, transparent)', radius:'22px', tail:'6px', border:'none', filter:'none', blur:'none' },
  1: { bg:'linear-gradient(135deg, var(--primary), var(--secondary))', shadow:'0 8px 28px color-mix(in srgb, var(--primary) 40%, transparent)', radius:'20px', tail:'4px', border:'none', filter:'none', blur:'none' },
  2: { bg:'linear-gradient(160deg, var(--primary), var(--accent))', shadow:'0 0 0 1px rgba(255,255,255,0.15), 0 10px 32px color-mix(in srgb, var(--primary) 35%, transparent)', radius:'16px', tail:'2px', border:'none', filter:'none', blur:'none' },
  3: { bg:'linear-gradient(135deg, #F59E0B, #EF4444)', shadow:'0 6px 24px rgba(245,158,11,0.35)', radius:'24px', tail:'8px', border:'none', filter:'none', blur:'none' },
  4: { bg:'linear-gradient(135deg, #06B6D4, #3B82F6)', shadow:'0 6px 24px rgba(6,182,212,0.35)', radius:'18px', tail:'6px', border:'none', filter:'none', blur:'none' },
  5: { bg:'linear-gradient(135deg, #EC4899, #8B5CF6)', shadow:'0 8px 28px rgba(236,72,153,0.35)', radius:'28px', tail:'10px', border:'none', filter:'none', blur:'none' },
  6: { bg:'rgba(255,255,255,0.14)', shadow:'0 8px 32px rgba(0,0,0,0.22)', radius:'20px', tail:'6px', border:'1px solid rgba(255,255,255,0.22)', filter:'none', blur:'12px' },
  7: { bg:'linear-gradient(135deg, var(--primary), var(--accent))', shadow:'0 0 20px color-mix(in srgb, var(--primary) 50%, transparent), 0 0 40px color-mix(in srgb, var(--secondary) 25%, transparent)', radius:'22px', tail:'6px', border:'none', filter:'saturate(1.15)', blur:'none' },
  8: { bg:'linear-gradient(135deg, #10B981, #059669)', shadow:'0 6px 22px rgba(16,185,129,0.35)', radius:'12px', tail:'4px', border:'none', filter:'none', blur:'none' },
  9: { bg:'linear-gradient(135deg, #1a1a2e, #16213e)', shadow:'0 8px 28px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)', radius:'16px', tail:'4px', border:'1px solid color-mix(in srgb, var(--primary) 50%, transparent)', filter:'none', blur:'none' },
};

function applyBubbleStyle(){
  const style = Math.max(0, Math.min(9, +(state.settings?.bubbleStyle ?? 0)));
  const v = BUBBLE_STYLE_VARS[style] || BUBBLE_STYLE_VARS[0];
  const root = document.documentElement;
  root.style.setProperty('--bubble-out-bg', v.bg);
  root.style.setProperty('--bubble-out-shadow', v.shadow);
  root.style.setProperty('--bubble-out-radius', v.radius);
  root.style.setProperty('--bubble-out-tail', v.tail);
  root.style.setProperty('--bubble-out-border', v.border);
  root.style.setProperty('--bubble-out-filter', v.filter);
  root.style.setProperty('--bubble-out-blur', v.blur);
  // keep body class for compatibility
  for(let i=0;i<10;i++) document.body.classList.remove('bubble-style-'+i);
  document.body.classList.add('bubble-style-'+style);
  // force paint existing bubbles without full re-render
  document.querySelectorAll('#messages .bubble.out').forEach(el=>{
    el.style.background = '';
    el.style.boxShadow = '';
    // clear any stale inline that could block vars
  });
}

function renderBubbleStylePicker(){
  const box = document.getElementById('bubbleStylePicker');
  if(!box) return;
  const current = +(state.settings?.bubbleStyle ?? 0);
  const pro = isPremium();
  box.innerHTML = BUBBLE_STYLES.map(s=>{
    const locked = s.id > 0 && !pro;
    return `<div class="bubble-style-swatch ${current===s.id?'active':''} ${locked?'lock':''}"
      style="background:${s.bg}" title="${s.name}" data-style="${s.id}"
      onclick="selectBubbleStyle(${s.id})"><div class="mini-b"></div></div>`;
  }).join('');
}

function selectBubbleStyle(id){
  id = +id;
  if(id < 0 || id > 9) return;
  if(id > 0 && !isPremium()){
    showToast('Стили пузырьков — в Premium');
    go('premium');
    return;
  }
  if(!state.settings) state.settings = {};
  state.settings.bubbleStyle = id;
  saveMeta();
  applyBubbleStyle();
  try{ applyBubbleRadius(); }catch(_){}
  renderBubbleStylePicker();
  showToast('Стиль «' + (BUBBLE_STYLES[id]?.name||id) + '»');
  if(navigator.vibrate) navigator.vibrate(10);
}

function toggleEdit(){
  go('profile-edit');
}
function handleImageUpload(input, target){
  const file = input.files[0];
  if(!file) return;
  const isVideo = file.type.startsWith('video/');
  if(target==='avatar' && isVideo && !isPremium()){
    showToast('Анимированный аватар — функция Premium');
    go('premium');
    return;
  }
  const maxMb = isPremium() ? 25 : 8;
  if(file.size > maxMb * 1024 * 1024){
    showToast('Файл слишком большой (макс. ' + maxMb + ' МБ)');
    return;
  }
  const reader = new FileReader();
  reader.onload = function(e){
    if(target==='avatar'){
      state.profile.avatar = e.target.result;
      state.profile.avatarType = isVideo ? 'video' : 'image';
      try{
        ensureAvatars();
        if((state.profile.avatars||[]).length < MAX_AVATARS){
          state.profile.avatars.push({ id: 'av_'+Date.now().toString(36), data: e.target.result, type: isVideo?'video':'image' });
        }
      }catch(_){}
      showToast(isVideo ? 'Анимированный аватар установлен' : 'Фото профиля обновлено');
      try{ renderAvatarGallery(); }catch(_){}
    } else {
      if(isVideo){ showToast('Обложка только изображение'); return; }
      state.profile.banner = e.target.result;
      showToast('Обложка обновлена');
    }
    saveMeta();
    renderProfile();
  };
  reader.readAsDataURL(file);
}

function setAvatarContent(el, profileOrInitials){
  if(!el) return;
  const p = typeof profileOrInitials === 'object' ? profileOrInitials : null;
  const initials = p ? ((p.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase() || '?') : String(profileOrInitials||'?');
  const existingVid = el.querySelector('video');
  if(existingVid) existingVid.remove();
  if(p && p.avatar && p.avatarType === 'video'){
    el.style.backgroundImage = '';
    el.textContent = '';
    const v = document.createElement('video');
    v.src = p.avatar;
    v.autoplay = true; v.muted = true; v.loop = true; v.playsInline = true;
    v.setAttribute('playsinline','');
    el.appendChild(v);
    v.play().catch(()=>{});
  } else if(p && p.avatar){
    el.style.backgroundImage = `url(${p.avatar})`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = initials;
  }
}

/* ========== STORAGE SCREEN ========== */
function renderStorage(){
  let msgs=0, voice=0, media=0;
  Object.values(state.chats).forEach(c=>{
    c.messages.forEach(m=>{
      msgs++;
      if(m.type==='voice') voice++;
      if(m.type==='image'||m.type==='file') media++;
    });
  });
  document.getElementById('storMsgs').textContent = msgs;
  document.getElementById('storVoice').textContent = voice;
  document.getElementById('storMedia').textContent = media;
  let size = 0;
  try{
    size = JSON.stringify(state.chats||{}).length;
  }catch(_){}
  document.getElementById('storSize').textContent = (size/1024).toFixed(1)+' KB';
  const sb = document.getElementById('storSupabase');
  if(sb) sb.textContent = 'не подключён (локальный режим)';
}
async function clearAllStorage(){
  if(!confirm('Удалить все локальные данные (чаты, кэш)?')) return;
  try{
    state.chats = {};
    if(db){
      try{ await idbClear('chats'); }catch(_){}
      try{ await idbClear('messages'); }catch(_){}
      try{ await idbClear('media'); }catch(_){}
    }
    showToast('Локальные данные очищены');
  }catch(_){}
  location.reload();
}

/* ========== SEARCH ========== */
let _filterListTimer = null;
function filterList(inputId, selector){
  clearTimeout(_filterListTimer);
  _filterListTimer = setTimeout(() => {
    const input = document.getElementById(inputId);
    if (!input) return;
    const q = input.value.trim().toLowerCase();
    const nodes = document.querySelectorAll(selector);
    let visible = 0;
    nodes.forEach(row => {
      const wrap = row.closest('.chat-row-wrap') || row;
      const hay = ((row.dataset.search || '') + ' ' + (row.dataset.name || '')).toLowerCase();
      const show = !q || hay.includes(q);
      wrap.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    // optional empty hint
    const list = document.getElementById('chatList');
    if (list && q) {
      let empty = list.querySelector('.filter-empty');
      if (!visible) {
        if (!empty) {
          empty = document.createElement('div');
          empty.className = 'filter-empty empty-state';
          empty.innerHTML = '<div class="title">Ничего не найдено</div><div class="desc">Попробуйте другой запрос</div>';
          list.appendChild(empty);
        }
      } else if (empty) empty.remove();
    } else {
      list?.querySelector('.filter-empty')?.remove();
    }
  }, 80);
}

/* Offline / online UX */
function updateOnlineBanner(){
  let bar = document.getElementById('offlineBanner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'offlineBanner';
    bar.className = 'offline-banner';
    bar.textContent = 'Нет сети — сообщения сохранятся локально';
    document.getElementById('app')?.prepend(bar);
  }
  const offline = navigator.onLine === false;
  bar.classList.toggle('show', offline);
  document.body.classList.toggle('is-offline', offline);
}
window.addEventListener('online', () => {
  updateOnlineBanner();
  showToast('Снова в сети');
  try {
    if (state.loggedIn && window.ChiperSync?.fullSyncAfterLogin) {
      ChiperSync.fullSyncAfterLogin().catch(()=>{});
    }
  } catch (_) {}
});
window.addEventListener('offline', () => {
  updateOnlineBanner();
  showToast('Офлайн-режим');
});
try { updateOnlineBanner(); } catch (_) {}
function toggleMsgSearch(){
  const bar = document.getElementById('msgSearchBar');
  bar.classList.toggle('active');
  if(bar.classList.contains('active')){
    document.getElementById('msgSearchInput').focus();
  } else {
    document.getElementById('msgSearchInput').value='';
    document.querySelectorAll('.bubble.search-hit, .bubble.search-hit-active').forEach(b=>{
      b.classList.remove('search-hit', 'search-hit-active');
    });
    state.searchHits = [];
    state.searchHitIdx = -1;
    const sc = document.getElementById('searchCount');
    if(sc) sc.textContent = '0';
  }
}
function searchInChat(){
  const q = document.getElementById('msgSearchInput').value.trim().toLowerCase();
  const hits = [];
  document.querySelectorAll('#messages .bubble').forEach(b=>{
    b.classList.remove('search-hit', 'search-hit-active');
    if(!q) return;
    const text = (b.querySelector('.bubble-text')?.textContent || b.textContent || '').toLowerCase();
    if(text.includes(q) && !b.classList.contains('deleted')){
      b.classList.add('search-hit');
      hits.push(b);
    }
  });
  state.searchHits = hits;
  state.searchHitIdx = hits.length ? 0 : -1;
  const sc = document.getElementById('searchCount');
  if(sc) sc.textContent = hits.length ? `1/${hits.length}` : '0';
  if(hits.length){
    hits[0].classList.add('search-hit-active');
    hits[0].scrollIntoView({behavior:'smooth', block:'center'});
  }
}
function searchInChatNav(dir){
  const hits = state.searchHits || [];
  if(!hits.length) return;
  hits.forEach(b => b.classList.remove('search-hit-active'));
  state.searchHitIdx = (state.searchHitIdx + dir + hits.length) % hits.length;
  const cur = hits[state.searchHitIdx];
  if(cur){
    cur.classList.add('search-hit-active');
    cur.scrollIntoView({behavior:'smooth', block:'center'});
  }
  const sc = document.getElementById('searchCount');
  if(sc) sc.textContent = `${state.searchHitIdx+1}/${hits.length}`;
}

/* ========== UTILS ========== */
function escapeHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function timeNow(){
  const d = new Date();
  return d.getHours()+':'+String(d.getMinutes()).padStart(2,'0');
}
function scrollMessagesToBottom(){
  const m = document.getElementById('messages');
  m.scrollTop = m.scrollHeight;
}
function rippleFx(e){
  const el = e.currentTarget;
  if(!el) return;
  const rect = el.getBoundingClientRect();
  const r = document.createElement('span');
  const size = Math.max(rect.width, rect.height);
  r.className = 'ripple';
  r.style.width = r.style.height = size+'px';
  r.style.left = ((e.clientX||rect.left+rect.width/2)-rect.left-size/2)+'px';
  r.style.top = ((e.clientY||rect.top+rect.height/2)-rect.top-size/2)+'px';
  el.appendChild(r);
  setTimeout(()=> r.remove(), 650);
}
let toastTimer;
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove('show'), 2400);
}
function showModal(title, text){
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalText').textContent = text;
  document.getElementById('modalOverlay').classList.add('show');
}
function closeModal(){ document.getElementById('modalOverlay').classList.remove('show'); }
// Focus trap helpers
document.getElementById('modalOverlay')?.addEventListener('keydown', e=>{
  if(e.key !== 'Tab') return;
  const focusables = document.getElementById('modalOverlay').querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if(!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length-1];
  if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
});

/* ========== SIDE DRAWER ========== */
function openDrawer(){
  document.getElementById('sideDrawer').classList.add('open');
  document.getElementById('drawerOverlay').classList.add('open');
  document.body.classList.add('drawer-open');
  const btn = document.getElementById('burgerBtn');
  if(btn) btn.setAttribute('aria-expanded','true');
  const p = state.profile || {};
  document.getElementById('drawerName').textContent = p.name || 'Пользователь';
  document.getElementById('drawerUser').textContent = p.username || '';
  setAvatarContent(document.getElementById('drawerAvatar'), p);
  if(navigator.vibrate) navigator.vibrate(8);
}
function closeDrawer(){
  document.getElementById('sideDrawer').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('open');
  document.body.classList.remove('drawer-open');
  const btn = document.getElementById('burgerBtn');
  if(btn) btn.setAttribute('aria-expanded','false');
}
function toggleDrawer(){
  const isOpen = document.getElementById('sideDrawer').classList.contains('open');
  if(isOpen) closeDrawer(); else openDrawer();
}
// close on Escape
document.addEventListener('keydown', (e)=>{
  if(e.key==='Escape'){ closeDrawer(); hideCtx(); hideReactions(); closeModal(); }
});
// swipe to close drawer
(function(){
  const drawer = document.getElementById('sideDrawer');
  if(!drawer) return;
  let startX=0, currentX=0, dragging=false;
  drawer.addEventListener('touchstart', e=>{
    startX = e.touches[0].clientX; currentX=startX; dragging=true;
  }, {passive:true});
  drawer.addEventListener('touchmove', e=>{
    if(!dragging) return;
    currentX = e.touches[0].clientX;
    const dx = currentX - startX;
    if(dx < 0){
      drawer.style.transform = `translateX(${dx}px) scale(1)`;
      document.getElementById('drawerOverlay').style.opacity = String(Math.max(0, 1 + dx/280));
    }
  }, {passive:true});
  drawer.addEventListener('touchend', ()=>{
    if(!dragging) return;
    dragging=false;
    const dx = currentX - startX;
    drawer.style.transform = '';
    document.getElementById('drawerOverlay').style.opacity = '';
    if(dx < -80) closeDrawer();
  });
})();

/* BroadcastChannel is in data layer (chiper_sync_v3) */

/* ========== PULL TO REFRESH (simple) ========== */
(function(){
  const scroll = document.getElementById('chatsScroll');
  if(!scroll) return;
  let startY=0, pulling=false;
  scroll.addEventListener('touchstart', e=>{ if(scroll.scrollTop<=0){ startY=e.touches[0].clientY; pulling=true; } }, {passive:true});
  scroll.addEventListener('touchmove', e=>{
    if(!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if(dy>0 && dy<100){
      document.getElementById('ptr').style.height = dy+'px';
    }
  }, {passive:true});
  scroll.addEventListener('touchend', ()=>{
    if(pulling && document.getElementById('ptr').offsetHeight>50){
      document.getElementById('ptr').textContent = 'Обновлено';
      renderChatList();
      setTimeout(()=>{ document.getElementById('ptr').style.height='0'; document.getElementById('ptr').textContent='Обновление…'; }, 600);
    } else document.getElementById('ptr').style.height='0';
    pulling=false;
  });
})();

/* parallax moved to throttled handler */


/* ========== BOTTOM SHEET ========== */
function openSheet(items){
  const content = document.getElementById('sheetContent');
  content.innerHTML = items.map((it,i)=>`
    <div class="sheet-item ${it.danger?'danger':''}" role="menuitem" data-i="${i}">
      ${it.icon||''} ${it.label}
    </div>`).join('');
  content.querySelectorAll('.sheet-item').forEach(el=>{
    el.onclick = ()=>{ items[+el.dataset.i].action(); closeSheet(); };
  });
  document.getElementById('sheetOverlay').classList.add('show');
  document.getElementById('bottomSheet').classList.add('show');
}
function closeSheet(){
  document.getElementById('sheetOverlay').classList.remove('show');
  document.getElementById('bottomSheet').classList.remove('show');
}

/* Override showMsgCtx / showChatCtx to use bottom sheet on mobile */
const _origShowMsgCtx = typeof showMsgCtx === 'function' ? showMsgCtx : null;
function showMsgCtx(e, m){
  const buildItems = ()=>{
    const items = [];
    if(m.deleted){
      items.push({ label:'Удалить у себя', icon:'🗑', danger:true, action:()=>deleteMsg(m.id) });
      items.push({ label:'Выбрать', icon:'☑', action:()=>enterSelectMode(m.id) });
      return items;
    }
    items.push({ label:'Ответить', icon:'↩', action:()=>setReply(m) });
    items.push({ label:'Реакция', icon:'😊', action:()=>showReactions(e, m) });
    if(m.type==='text' && m.text){
      items.push({ label:'Копировать', icon:'📋', action:()=>{
        navigator.clipboard?.writeText(m.text).then(()=>showToast('Скопировано')).catch(()=>showToast('Не удалось скопировать'));
      }});
    }
    if(isMessageOut(m) && m.type==='text') items.push({ label:'Изменить', icon:'✎', action:()=>editMsg(m.id) });
    items.push({ label:'Переслать', icon:'↪', action:()=>forwardMsg(m) });
    items.push({ label:'Выбрать', icon:'☑', action:()=>enterSelectMode(m.id) });
    // Pin available for everyone (DM + groups/channels with rights)
    const ch = state.chats[state.currentChatId];
    if(ch){
      const canPin = !ch.isChannel || canPostInChat(ch);
      if(canPin){
        if(ch.pinnedMsgId === m.id) items.push({ label:'Открепить', icon:'📌', action:()=>unpinMessage() });
        else items.push({ label:'Закрепить', icon:'📌', action:()=>pinMessage(m.id) });
      }
    }
    items.push({ label:'Удалить', icon:'🗑', danger:true, action:()=>deleteMsg(m.id) });
    return items;
  };

  if(window.innerWidth < 700){
    openSheet(buildItems());
  } else if(_origShowMsgCtx) {
    // Prefer unified items on desktop ctx menu too
    const menu = document.getElementById('ctxMenu');
    const items = buildItems();
    menu.innerHTML = items.map(it=>`<div class="ctx-item ${it.danger?'danger':''}" role="menuitem">${it.icon} ${it.label}</div>`).join('');
    menu.querySelectorAll('.ctx-item').forEach((el,i)=>{ el.onclick = ()=>{ items[i].action(); hideCtx(); }; });
    positionMenu(menu, e);
    menu.classList.add('show');
  } else {
    const menu = document.getElementById('ctxMenu');
    const items = buildItems();
    menu.innerHTML = items.map(it=>`<div class="ctx-item ${it.danger?'danger':''}" role="menuitem">${it.icon} ${it.label}</div>`).join('');
    menu.querySelectorAll('.ctx-item').forEach((el,i)=>{ el.onclick = ()=>{ items[i].action(); hideCtx(); }; });
    positionMenu(menu, e);
    menu.classList.add('show');
  }
}

/* ========== WEBRTC CALLS ========== */
let callStream = null;
let callPc = null;
let callMuted = false;
let callCamOff = false;
let callIsVideo = false;
let callTimerInt = null;
let callStartedAt = 0;

async function startCall(video){
  const chatId = state.currentChatId;
  if(!chatId){ showToast('Откройте чат'); return; }
  const chat = state.chats[chatId];
  if(chat?.isChannel){ showToast('В каналы нельзя звонить'); return; }
  if(chat?.isGroup){ showToast('Групповые звонки скоро'); return; }
  const contact = getContact(chat?.contactId || chatId);
  callIsVideo = !!video;
  callMuted = false;
  callCamOff = false;
  document.getElementById('callName').textContent = contact.name;
  document.getElementById('callStatus').textContent = 'Подключение…';
  document.getElementById('callAvatarFallback').textContent = contact.initials || '?';
  document.getElementById('callAvatarFallback').style.display = video ? 'none' : 'flex';
  const pulse = document.getElementById('callPulseRing');
  if(pulse) pulse.style.display = video ? 'none' : 'flex';
  document.getElementById('callCamBtn').style.display = video ? 'flex' : 'none';
  document.getElementById('callLocalVideo').style.display = video ? 'block' : 'none';
  document.getElementById('callRemoteVideo').style.display = video ? 'block' : 'none';
  document.getElementById('callOverlay').classList.add('active');

  try{
    callStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  }catch(err){
    endCall();
    showModal(video ? 'Нет доступа к камере' : 'Нет доступа к микрофону',
      'Разрешите доступ в настройках браузера для звонков.');
    return;
  }

  const localVid = document.getElementById('callLocalVideo');
  const remoteVid = document.getElementById('callRemoteVideo');
  if(video){
    localVid.srcObject = callStream;
    // Demo: mirror local stream as "remote" for single-device (real P2P needs signaling server)
    remoteVid.srcObject = callStream;
  }

  // WebRTC peer connection ready for real signaling
  try{
    callPc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    callStream.getTracks().forEach(t => callPc.addTrack(t, callStream));
    callPc.ontrack = (ev) => {
      if(remoteVid && ev.streams[0]) remoteVid.srcObject = ev.streams[0];
    };
    // Local demo offer (no remote peer without server)
    const offer = await callPc.createOffer();
    await callPc.setLocalDescription(offer);
    if(bc) bc.postMessage({ type: 'call_offer', chatId, sdp: offer, video, from: state.profile.username });
  }catch(_){}

  callStartedAt = Date.now();
  document.getElementById('callStatus').textContent = '00:00';
  callTimerInt = setInterval(()=>{
    const s = Math.floor((Date.now()-callStartedAt)/1000);
    document.getElementById('callStatus').textContent =
      String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
  }, 500);
  if(navigator.vibrate) navigator.vibrate([20,40,20]);
}

function toggleCallMute(){
  if(!callStream) return;
  callMuted = !callMuted;
  callStream.getAudioTracks().forEach(t => t.enabled = !callMuted);
  document.getElementById('callMuteBtn').classList.toggle('off', callMuted);
}

function toggleCallCam(){
  if(!callStream) return;
  callCamOff = !callCamOff;
  callStream.getVideoTracks().forEach(t => t.enabled = !callCamOff);
  document.getElementById('callCamBtn').classList.toggle('off', callCamOff);
  document.getElementById('callLocalVideo').style.opacity = callCamOff ? '0.3' : '1';
}
let callSpeakerOn = true;
function toggleCallSpeaker(){
  callSpeakerOn = !callSpeakerOn;
  document.getElementById('callSpeakerBtn')?.classList.toggle('off', !callSpeakerOn);
  // In real WebRTC: set remote audio element.volume / sinkId
  showToast(callSpeakerOn ? 'Динамик вкл.' : 'Динамик выкл.');
}

function endCall(){
  clearInterval(callTimerInt);
  if(callStream){ callStream.getTracks().forEach(t=>t.stop()); callStream = null; }
  if(callPc){ try{ callPc.close(); }catch(_){} callPc = null; }
  const localVid = document.getElementById('callLocalVideo');
  const remoteVid = document.getElementById('callRemoteVideo');
  if(localVid) localVid.srcObject = null;
  if(remoteVid) remoteVid.srcObject = null;
  document.getElementById('callOverlay').classList.remove('active');
  if(bc) bc.postMessage({ type: 'call_end', chatId: state.currentChatId });
}


/* ========== CHIPER v4 PRODUCT LAYER ========== */
state.drafts = state.drafts || {};
state.settings = Object.assign({
  theme: 'system', accent: 'blue', privacy: false, notifications: true,
  compact: false, themeSchedule: false, themeNightStart: 22, themeNightEnd: 7,
  bubbleStyle: 0
}, state.settings || {});

const FREE_MAX_FILE_MB = 8;
const PRO_MAX_FILE_MB = 25;
const FREE_MAX_CHANNELS = 3;

function countChannels(){
  return Object.values(state.chats).filter(c => c.isChannel).length;
}

function canPostInChat(chat){
  if(!chat) return false;
  if(chat.isChannel){
    // creator / admin only
    const me = getCurrentUserKey().replace(/^@/,'');
    const admins = chat.admins || (chat.members && chat.members[0] ? [chat.members[0]] : [me]);
    const creator = (chat.createdBy || admins[0] || me).replace(/^@/,'');
    return admins.map(a=>String(a).replace(/^@/,'')).includes(me) || creator === me;
  }
  return true;
}

function updateChannelInputState(){
  const chat = state.chats[state.currentChatId];
  const can = canPostInChat(chat);
  const bar = document.getElementById('inputBar');
  const hint = document.getElementById('channelReadonlyHint');
  if(chat && chat.isChannel && !can){
    if(bar) bar.style.display = 'none';
    if(hint) hint.classList.add('show');
  } else {
    if(bar && !document.getElementById('recordingBar')?.classList.contains('active')) bar.style.display = 'flex';
    if(hint) hint.classList.remove('show');
  }
}

/* Drafts */
function saveDraft(){
  const id = state.currentChatId;
  if(!id) return;
  const val = document.getElementById('msgInput')?.value || '';
  if(!state.drafts) state.drafts = {};
  if(val.trim()) state.drafts[id] = val;
  else delete state.drafts[id];
  try{ saveMeta(); }catch(_){}
}
function loadDraft(chatId){
  const input = document.getElementById('msgInput');
  if(!input) return;
  const d = (state.drafts || {})[chatId] || '';
  input.value = d;
  onTypeInput();
}

/* Notifications */
async function ensureNotifPermission(){
  if(!('Notification' in window)) return false;
  if(Notification.permission === 'granted') return true;
  if(Notification.permission === 'denied') return false;
  const p = await Notification.requestPermission();
  return p === 'granted';
}
function notifyNewMessage(chatId, msg){
  if(!state.settings.notifications) return;
  if(document.hasFocus() && state.currentChatId === chatId) return;
  if(!('Notification' in window) || Notification.permission !== 'granted') return;
  const contact = getContact(state.chats[chatId]?.contactId || chatId);
  const body = msg.type === 'voice' ? '🎤 Голосовое' : msg.type === 'image' ? '📷 Фото' : (msg.text || 'Новое сообщение');
  try{
    const n = new Notification(contact.name || 'Chiper', { body: body.slice(0,120), tag: 'chiper-'+chatId, silent: false });
    n.onclick = () => { window.focus(); openChat(chatId); n.close(); };
  }catch(_){}
}

/* Global search */
function runGlobalSearch(){
  const box = document.getElementById('globalSearchResults');
  if(!box) return;
  const q = (document.getElementById('globalSearchInput')?.value || '').trim().toLowerCase().replace(/^@/,'');
  if(!q){
    box.innerHTML = `<div class="empty-state"><div class="emoji">🔍</div><div class="title">Глобальный поиск</div><div class="desc">Ищите по имени, @username, каналам и тексту сообщений</div></div>`;
    return;
  }
  let html = '';
  // users / chats
  const chatHits = [];
  Object.entries(state.chats).forEach(([id, chat])=>{
    const c = getContact(chat.contactId || id);
    const title = (chat.title || c.name || '').toLowerCase();
    const handle = (chat.handle || c.username || '').toLowerCase().replace(/^@/,'');
    if(title.includes(q) || handle.includes(q) || id.toLowerCase().includes(q)){
      chatHits.push({ id, label: chat.title || c.name, sub: chat.isChannel ? 'Канал' : chat.isGroup ? 'Группа' : (c.username||'') });
    }
  });
  // accounts index
  const userHits = [];
  Object.values(state.usersIndex||{}).forEach(u=>{
    const un = (u.username||'').toLowerCase().replace(/^@/,'');
    const nm = (u.name||'').toLowerCase();
    if(un.includes(q) || nm.includes(q)){
      userHits.push(u);
    }
  });
  // messages
  const msgHits = [];
  Object.entries(state.chats).forEach(([id, chat])=>{
    (chat.messages||[]).forEach(m=>{
      if(m.text && m.text.toLowerCase().includes(q)){
        msgHits.push({ chatId: id, msg: m, snip: m.text });
      }
    });
  });
  if(chatHits.length){
    html += '<div class="gs-section">Чаты и каналы</div>';
    chatHits.slice(0,20).forEach(h=>{
      html += `<div class="gs-hit glass pressable" onclick="openChat('${h.id}')"><div class="gs-title">${escapeHtml(h.label)}</div><div class="gs-snip">${escapeHtml(h.sub)}</div></div>`;
    });
  }
  if(userHits.length){
    html += '<div class="gs-section">Пользователи</div>';
    userHits.slice(0,15).forEach(u=>{
      const id = (u.id || (u.username||'').replace(/^@/,'')).toLowerCase();
      html += `<div class="gs-hit glass pressable" onclick="(function(){const cid=dmChatId(getCurrentUserKey(),'${id}');if(!state.chats[cid]){state.chats[cid]={contactId:'${id}',messages:[],unread:0,archived:false,pinned:false,lastTs:Date.now()};persistChatMeta(cid);}openChat(cid);})()"><div class="gs-title">${escapeHtml(u.name||id)}</div><div class="gs-snip">${escapeHtml(u.username||('@'+id))}</div></div>`;
    });
  }
  if(msgHits.length){
    html += '<div class="gs-section">Сообщения</div>';
    msgHits.slice(0,30).forEach(h=>{
      const c = getContact(state.chats[h.chatId]?.contactId || h.chatId);
      html += `<div class="gs-hit glass pressable" onclick="openChat('${h.chatId}')"><div class="gs-title">${escapeHtml(c.name)}</div><div class="gs-snip">${escapeHtml(h.snip.slice(0,80))}</div></div>`;
    });
  }
  if(!html){
    html = `<div class="empty-state"><div class="emoji">😕</div><div class="title">Ничего не найдено</div><div class="desc">Попробуйте другой запрос</div></div>`;
  }
  box.innerHTML = html;
}

/* Compact mode */
function toggleCompact(){
  state.settings.compact = !state.settings.compact;
  document.body.classList.toggle('compact-mode', !!state.settings.compact);
  const t = document.getElementById('compactToggle');
  if(t){ t.classList.toggle('on', !!state.settings.compact); t.setAttribute('aria-checked', !!state.settings.compact); }
  saveMeta();
  showToast(state.settings.compact ? 'Компактный режим' : 'Обычный режим');
}
function applyCompact(){
  document.body.classList.toggle('compact-mode', !!state.settings.compact);
  const t = document.getElementById('compactToggle');
  if(t){ t.classList.toggle('on', !!state.settings.compact); t.setAttribute('aria-checked', !!state.settings.compact); }
}

/* Theme schedule: dark at night */
function applyThemeSchedule(){
  if(!state.settings.themeSchedule) return;
  const h = new Date().getHours();
  const start = state.settings.themeNightStart ?? 22;
  const end = state.settings.themeNightEnd ?? 7;
  let night = false;
  if(start > end) night = h >= start || h < end;
  else night = h >= start && h < end;
  // only override when system/schedule mode
  if((state.settings.theme || 'system') === 'system' || state.settings.themeSchedule){
    document.documentElement.setAttribute('data-theme', night ? 'dark' : 'light');
  }
}

/* Swipe chat row */
function setupChatRowSwipe(wrap, chatId){
  let startX=0, dx=0, active=false;
  const row = wrap.querySelector('.chat-row');
  wrap.addEventListener('touchstart', e=>{ startX=e.touches[0].clientX; dx=0; active=true; }, {passive:true});
  wrap.addEventListener('touchmove', e=>{
    if(!active) return;
    dx = e.touches[0].clientX - startX;
    if(dx < 0){
      const t = Math.max(-140, dx);
      row.style.transition = 'none';
      row.style.transform = `translateX(${t}px)`;
    }
  }, {passive:true});
  wrap.addEventListener('touchend', ()=>{
    if(!active) return;
    active=false;
    row.style.transition = '';
    if(dx < -70){
      wrap.classList.add('swiped');
      row.style.transform = 'translateX(-140px)';
    } else {
      wrap.classList.remove('swiped');
      row.style.transform = '';
    }
  });
}

/* Pin message */
function pinMessage(msgId){
  const chat = state.chats[state.currentChatId];
  if(!chat) return;
  if(chat.isChannel && !canPostInChat(chat)){ showToast('Нет прав'); return; }
  chat.pinnedMsgId = msgId;
  persistChatMeta(state.currentChatId);
  renderPinnedBar();
  showToast('Сообщение закреплено');
}
function unpinMessage(){
  const chat = state.chats[state.currentChatId];
  if(!chat) return;
  chat.pinnedMsgId = null;
  persistChatMeta(state.currentChatId);
  renderPinnedBar();
  showToast('Закрепление снято');
}
function renderPinnedBar(){
  const bar = document.getElementById('pinnedBar');
  const chat = state.chats[state.currentChatId];
  if(!bar || !chat || !chat.pinnedMsgId){ if(bar) bar.classList.remove('show'); return; }
  const m = (chat.messages||[]).find(x=>x.id===chat.pinnedMsgId);
  if(!m || m.deleted){ bar.classList.remove('show'); return; }
  document.getElementById('pinnedText').textContent = m.text || formatLast(m);
  bar.classList.add('show');
}
function scrollToPinned(){
  const chat = state.chats[state.currentChatId];
  if(!chat?.pinnedMsgId) return;
  const el = document.querySelector(`.bubble[data-id="${chat.pinnedMsgId}"]`);
  if(el){
    el.scrollIntoView({behavior:'smooth', block:'center'});
    el.classList.add('search-hit-active');
    setTimeout(()=>el.classList.remove('search-hit-active'), 1400);
  }
}

/* Invite links */
function makeInviteLink(chatId){
  const chat = state.chats[chatId];
  if(!chat) return '';
  const token = btoa(unescape(encodeURIComponent(chatId))).replace(/=+$/,'').slice(0,16);
  chat.inviteToken = chat.inviteToken || token;
  persistChatMeta(chatId);
  return `https://chiper.app/join/${chat.inviteToken}`;
}
function copyInviteLink(){
  const link = makeInviteLink(state.currentChatId);
  if(navigator.clipboard) navigator.clipboard.writeText(link).then(()=>showToast('Ссылка скопирована'));
  else { prompt('Ссылка-приглашение:', link); }
}

/* Premium checkout */
function buyPremium(){
  showToast('Покупка Premium за деньги отключена');
}
function checkoutNext(){
  showToast('Покупка Premium за деньги отключена');
}
function cancelCheckout(){
  const checkoutFlow = document.getElementById('checkoutFlow');
  if(checkoutFlow) checkoutFlow.style.display = 'none';
}
function checkoutConfirm(){
  showToast('Покупка Premium за деньги отключена');
  state.profile.premiumUntil = Date.now() + days * 24 * 60 * 60 * 1000;
  state.profile.badge = 'premium';
  try{
    const accounts = loadAccounts();
    const email = state.profile.email;
    if(email && accounts[email]){
      accounts[email].profile = { ...accounts[email].profile, ...state.profile };
      saveAccounts(accounts);
    }
  }catch(_){}
  saveMeta();
  cancelCheckout();
  renderPremium();
  renderProfile();
  showToast('Premium активирован ✨');
  if(navigator.vibrate) navigator.vibrate([20,40,20]);
}

/* File size limits */
const _origHandleFileAttach = typeof handleFileAttach === 'function' ? handleFileAttach : null;

/* Group call UI */
const _origStartCall = typeof startCall === 'function' ? startCall : null;
async function startCallEnhanced(video){
  const chat = state.chats[state.currentChatId];
  if(chat?.isGroup){
    showToast('Групповые звонки скоро');
    const parts = document.getElementById('callParticipants');
    if(parts){
      parts.style.display = 'flex';
      parts.innerHTML = (chat.members||[]).slice(0,8).map((u,i)=>{
        const un = String(u).replace(/^@/,'');
        return `<div class="call-part av-g${(i%5)+1}">${un.slice(0,2).toUpperCase()}</div>`;
      }).join('') + '<div style="width:100%;text-align:center;font-size:12px;color:var(--text-secondary);margin-top:8px;">Скоро: до 8 участников</div>';
    }
    document.getElementById('callOverlay')?.classList.add('active');
    document.getElementById('callName').textContent = chat.title || 'Группа';
    document.getElementById('callStatus').textContent = 'Групповые звонки в разработке';
    return;
  }
  if(partsHide){}
  const parts = document.getElementById('callParticipants');
  if(parts) parts.style.display = 'none';
  return startCall(video);
}
// alias
window.startCall = function(video){
  const chat = state.chats[state.currentChatId];
  if(chat?.isGroup){
    showToast('Групповые звонки скоро');
    const parts = document.getElementById('callParticipants');
    if(parts){
      parts.style.display = 'flex';
      const members = chat.members || [];
      parts.innerHTML = members.slice(0,8).map((u,i)=>{
        const un = String(u).replace(/^@/,'');
        return `<div class="call-part" style="background:linear-gradient(135deg,var(--primary),var(--secondary))">${un.slice(0,2).toUpperCase()}</div>`;
      }).join('') + '<div style="width:100%;text-align:center;font-size:12px;color:var(--text-secondary);margin-top:8px;">Скоро: до 8 участников</div>';
    }
    document.getElementById('callName').textContent = chat.title || 'Группа';
    document.getElementById('callStatus').textContent = 'Групповые звонки в разработке';
    document.getElementById('callAvatarFallback').style.display = 'flex';
    document.getElementById('callAvatarFallback').textContent = (chat.title||'Г').slice(0,2).toUpperCase();
    document.getElementById('callOverlay').classList.add('active');
    return;
  }
  const parts = document.getElementById('callParticipants');
  if(parts) parts.style.display = 'none';
  // call original implementation by temporarily restoring from script - inline duplicate minimal path
  return startCallOriginal(video);
};

async function startCallOriginal(video){
  const chatId = state.currentChatId;
  if(!chatId){ showToast('Откройте чат'); return; }
  const chat = state.chats[chatId];
  if(chat?.isChannel){ showToast('В каналы нельзя звонить'); return; }
  const contact = getContact(chat?.contactId || chatId);
  callIsVideo = !!video;
  callMuted = false;
  callCamOff = false;
  document.getElementById('callName').textContent = contact.name;
  document.getElementById('callStatus').textContent = 'Подключение…';
  document.getElementById('callAvatarFallback').textContent = contact.initials || '?';
  document.getElementById('callAvatarFallback').style.display = video ? 'none' : 'flex';
  const pulse = document.getElementById('callPulseRing');
  if(pulse) pulse.style.display = video ? 'none' : 'flex';
  document.getElementById('callCamBtn').style.display = video ? 'flex' : 'none';
  document.getElementById('callLocalVideo').style.display = video ? 'block' : 'none';
  document.getElementById('callRemoteVideo').style.display = video ? 'block' : 'none';
  document.getElementById('callOverlay').classList.add('active');
  try{
    callStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  }catch(err){
    endCall();
    showModal(video ? 'Нет доступа к камере' : 'Нет доступа к микрофону', 'Разрешите доступ в настройках браузера для звонков.');
    return;
  }
  const localVid = document.getElementById('callLocalVideo');
  const remoteVid = document.getElementById('callRemoteVideo');
  if(video){ localVid.srcObject = callStream; remoteVid.srcObject = callStream; }
  try{
    callPc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    callStream.getTracks().forEach(t => callPc.addTrack(t, callStream));
    callPc.ontrack = (ev) => { if(remoteVid && ev.streams[0]) remoteVid.srcObject = ev.streams[0]; };
    const offer = await callPc.createOffer();
    await callPc.setLocalDescription(offer);
    if(bc) bc.postMessage({ type: 'call_offer', chatId, sdp: offer, video, from: state.profile.username });
  }catch(_){}
  callStartedAt = Date.now();
  document.getElementById('callStatus').textContent = '00:00';
  callTimerInt = setInterval(()=>{
    const s = Math.floor((Date.now()-callStartedAt)/1000);
    document.getElementById('callStatus').textContent = String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
  }, 500);
  if(navigator.vibrate) navigator.vibrate([20,40,20]);
}

/* PWA service worker — offline shell + push skeleton */
function registerPWA(){
  if(!('serviceWorker' in navigator)) return;
  try {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW register failed', e));
  } catch (_) {}
}

/* Keyboard shortcut Ctrl/Cmd+K global search */
document.addEventListener('keydown', e=>{
  if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){
    e.preventDefault();
    go('newchat');
    setTimeout(()=>document.getElementById('contactSearch')?.focus(), 100);
  }
});

/* Request notif on settings toggle */
const _origSaveSettings = typeof saveSettings === 'function' ? saveSettings : null;
function saveSettings(){
  state.settings.privacy = document.getElementById('privacyToggle')?.classList.contains('on')||false;
  state.settings.notifications = document.getElementById('notifToggle')?.classList.contains('on')||true;
  if(state.settings.notifications) ensureNotifPermission();
  saveMeta();
}



/* ========== CHIPER COINS / BADGES / ADMIN / AVATARS / REAL WEBRTC ========== */
const ADMIN_EMAILS = ['gapspapspspsp10374hsi@gmail.com'];
const ADMIN_USERNAMES = ['gapspapspspsp10374hsi'];
const PREMIUM_PRICE_MONTH_CC = 299;
const PREMIUM_PRICE_YEAR_CC = 999;
const MAX_AVATARS = 5;
let adminTargetKey = null; // email or username key in accounts
let pendingOffer = null;
let pendingOfferFrom = null;
let callChatId = null;
let callRole = null; // 'caller' | 'callee'
let iceBuf = [];

function isAdminUser(){
  try{ if(typeof adminUnlocked !== 'undefined' && adminUnlocked) return true; }catch(_){}
  try{ if(sessionStorage.getItem('chiper_admin_ok') === '1') return true; }catch(_){}
  const p = state.profile || {};
  if(p.isAdmin === false) return false;
  const email = (p.email || '').toLowerCase().trim();
  const u = (p.username || '').replace(/^@/,'').toLowerCase();
  if(ADMIN_EMAILS.includes(email)) return true;
  if(ADMIN_USERNAMES.includes(u)) return true;
  if(p.isAdmin) return true;
  return false;
}

function getCoins(){ return Math.max(0, +(state.profile?.coins || 0)); }
function getStars(){ return Math.max(0, +(state.profile?.stars || 0)); }
function isVerified(){ return !!(state.profile && state.profile.verified); }

function persistProfileToAccounts(){
  try{
    const accounts = loadAccounts();
    const email = state.profile?.email;
    if(email && accounts[email]){
      accounts[email].profile = { ...accounts[email].profile, ...state.profile };
      saveAccounts(accounts);
    }
  }catch(_){}
  saveMeta();
}

function updateCoinsUI(){
  const c = getCoins();
  const s = getStars();
  const adminRow = document.getElementById('adminSettingsRow');
  if(adminRow) adminRow.style.display = ''; // password gate inside
  try{
    const big = document.getElementById('coinsBalanceBig');
    if(big) big.textContent = getCoins().toLocaleString('ru-RU');
  }catch(_){}
  try{
    const hint = document.getElementById('settingsCoinsHint');
    if(hint) hint.textContent = (c || 0).toLocaleString('ru-RU') + ' CC';
  }catch(_){}
}

function buyPremiumWithCoins(){
  if(isPremium()){ showToast('Premium уже активен'); return; }
  const cost = selectedPremiumPlan === 'year' ? PREMIUM_PRICE_YEAR_CC : PREMIUM_PRICE_MONTH_CC;
  const days = selectedPremiumPlan === 'year' ? 365 : 30;
  if(getCoins() < cost){
    showToast('Недостаточно Chiper Coin (' + cost + ' CC)');
    return;
  }
  state.profile.coins = getCoins() - cost;
  state.profile.premium = true;
  state.profile.premiumUntil = Date.now() + days * 24 * 60 * 60 * 1000;
  state.profile.badge = 'premium';
  persistProfileToAccounts();
  try{ pushCoinTx('Chiper Premium', -cost, days + ' дн.'); }catch(_){}
  updateCoinsUI();
  renderPremium();
  renderProfile();
  try{ renderCoinsPage(); }catch(_){}
  showToast('Premium куплен за ' + cost + ' CC ✨');
  if(navigator.vibrate) navigator.vibrate([20,40,20]);
}

/* ---- Multi avatars ---- */
function ensureAvatars(){
  if(!state.profile) state.profile = {};
  if(!Array.isArray(state.profile.avatars)) state.profile.avatars = [];
  if(state.profile.avatar && !state.profile.avatars.length){
    state.profile.avatars.push({
      id: 'av_main',
      data: state.profile.avatar,
      type: state.profile.avatarType || 'image'
    });
  }
}

function renderAvatarGallery(){
  ensureAvatars();
  const box = document.getElementById('avatarGallery');
  if(!box) return;
  const list = state.profile.avatars || [];
  const active = state.profile.avatar;
  if(!list.length){
    box.innerHTML = '<span class="hint-text">Пока нет сохранённых аватаров</span>';
    return;
  }
  box.innerHTML = list.map(a => {
    const isAct = a.data === active;
    const bg = a.type === 'video' ? '' : `background-image:url(${a.data})`;
    return `<div class="av-gallery-item ${isAct?'active':''}" style="${bg}" onclick="setActiveAvatar('${a.id}')" title="Сделать основным">
      ${a.type==='video'?'▶':''}
      <button class="av-del" onclick="event.stopPropagation();removeAvatar('${a.id}')" aria-label="Удалить">×</button>
    </div>`;
  }).join('');
}

function setActiveAvatar(id){
  ensureAvatars();
  const a = (state.profile.avatars || []).find(x => x.id === id);
  if(!a) return;
  state.profile.avatar = a.data;
  state.profile.avatarType = a.type || 'image';
  persistProfileToAccounts();
  renderProfile();
  renderAvatarGallery();
  showToast('Аватар выбран');
}

function removeAvatar(id){
  ensureAvatars();
  const list = state.profile.avatars || [];
  const a = list.find(x => x.id === id);
  state.profile.avatars = list.filter(x => x.id !== id);
  if(a && state.profile.avatar === a.data){
    const next = state.profile.avatars[0];
    if(next){ state.profile.avatar = next.data; state.profile.avatarType = next.type; }
    else { state.profile.avatar = null; state.profile.avatarType = null; }
  }
  persistProfileToAccounts();
  renderProfile();
  renderAvatarGallery();
  showToast('Аватар удалён');
}

function addAvatarFromFile(input){
  const file = input.files?.[0];
  if(!file) return;
  ensureAvatars();
  if((state.profile.avatars || []).length >= MAX_AVATARS){
    showToast('Максимум ' + MAX_AVATARS + ' аватаров');
    input.value = '';
    return;
  }
  const isVideo = file.type.startsWith('video/');
  if(isVideo && !isPremium()){
    showToast('Видео-аватар — Premium');
    go('premium');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const data = e.target.result;
    const id = 'av_' + Date.now().toString(36);
    state.profile.avatars.push({ id, data, type: isVideo ? 'video' : 'image' });
    state.profile.avatar = data;
    state.profile.avatarType = isVideo ? 'video' : 'image';
    persistProfileToAccounts();
    renderProfile();
    renderAvatarGallery();
    showToast('Аватар добавлен');
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function openAvatarViewer(){
  ensureAvatars();
  const p = state.profile || {};
  const ov = document.getElementById('avatarViewerOverlay');
  const img = document.getElementById('avatarViewerImg');
  const vid = document.getElementById('avatarViewerVideo');
  if(!ov) return;
  if(p.avatar && p.avatarType === 'video'){
    img.style.display = 'none';
    vid.style.display = 'block';
    vid.src = p.avatar;
  } else if(p.avatar){
    vid.style.display = 'none';
    img.style.display = 'block';
    img.src = p.avatar;
  } else {
    showToast('Аватар не установлен — загрузите фото');
    document.getElementById('avatarFile')?.click();
    return;
  }
  ov.classList.add('show');
}

function closeAvatarViewer(){
  document.getElementById('avatarViewerOverlay')?.classList.remove('show');
  const vid = document.getElementById('avatarViewerVideo');
  if(vid){ vid.pause(); vid.removeAttribute('src'); }
}

function downloadCurrentAvatar(){
  const p = state.profile || {};
  if(!p.avatar){ showToast('Нет аватара'); return; }
  const a = document.createElement('a');
  a.href = p.avatar;
  a.download = 'chiper-avatar.' + (p.avatarType === 'video' ? 'webm' : 'jpg');
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('Скачивание…');
}

/* Hook handleImageUpload to also push into gallery */
const _origHandleImageUpload = typeof handleImageUpload === 'function' ? handleImageUpload : null;

/* ---- Admin ---- */
async function adminSearchUser(){
  const q = (document.getElementById('adminUserQuery')?.value || '').trim().toLowerCase().replace(/^@/,'');
  const box = document.getElementById('adminUserResult');
  const actions = document.getElementById('adminActions');
  if(!box) return;
  if(!q){ box.innerHTML = ''; if(actions) actions.style.display='none'; adminTargetKey=null; window._adminTargetProfile=null; return; }
  let p = null;
  // self shortcut
  const meU = (state.profile?.username || '').toLowerCase().replace(/^@/,'');
  const meE = (state.profile?.email || '').toLowerCase();
  if(meU.includes(q) || meE.includes(q)){
    p = { ...state.profile };
    adminTargetKey = state.profile.uid || '__self__';
  }
  if(!p){
    try{
      const accounts = loadAccounts();
      for(const [email, a] of Object.entries(accounts)){
        const pr = a.profile || {};
        const un = (pr.username || '').toLowerCase().replace(/^@/,'');
        if(un.includes(q) || email.includes(q) || (pr.name||'').toLowerCase().includes(q)){
          p = { ...pr, email };
          adminTargetKey = pr.uid || email;
          break;
        }
      }
    }catch(e){ console.warn(e); }
  }
  if(!p){
    box.innerHTML = '<div class="hint-text">Не найден (локальные аккаунты)</div>';
    if(actions) actions.style.display='none';
    adminTargetKey = null;
    window._adminTargetProfile = null;
    return;
  }
  window._adminTargetProfile = p;
  box.innerHTML = '';
  if(actions){
    actions.style.display = '';
    const label = document.getElementById('adminTargetLabel');
    if(label) label.textContent = (p.name || p.username || adminTargetKey) + '';
    const meta = document.getElementById('adminTargetMeta');
    if(meta) meta.textContent = (p.username||'') + ' · CC: ' + (+(p.coins||0)) + ' · ★ ' + (+(p.stars||0)) + ' · ' + (p.verified?'✓ ':'') + (p.premium?'PRO':'Free');
    const av = document.getElementById('adminTargetAvatar');
    if(av){
      const initials = ((p.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2)||'?').toUpperCase();
      if(p.avatar){ av.style.backgroundImage = 'url('+p.avatar+')'; av.textContent=''; }
      else { av.style.backgroundImage=''; av.textContent = initials; }
    }
  }
}

function _adminGetTargetProfile(){
  if(!adminTargetKey) return null;
  if(adminTargetKey === '__self__' || adminTargetKey === state.profile?.uid){
    return { kind:'self', profile: state.profile, uid: state.profile.uid };
  }
  const p = window._adminTargetProfile || null;
  if(!p) return null;
  return { kind:'fs', profile: p, uid: adminTargetKey };
}

async function _adminSaveTarget(t){
  if(t.kind === 'self'){
    Object.assign(state.profile, t.profile);
    await persistProfileToAccounts();
  } else {
    // update local account by uid or email
    const accounts = loadAccounts();
    let key = null;
    for(const [email, a] of Object.entries(accounts)){
      if(email === t.uid || a.profile?.uid === t.uid || a.profile?.uid === adminTargetKey || email === adminTargetKey){
        key = email; break;
      }
    }
    if(key){
      accounts[key].profile = { ...(accounts[key].profile || {}), ...t.profile };
      saveAccounts(accounts);
      if(state.profile?.email === key || state.profile?.uid === t.uid){
        Object.assign(state.profile, t.profile);
        saveMeta();
      }
    }
  }
  try{ rebuildUsersIndex(); }catch(_){}
  renderProfile();
  updateCoinsUI();
  adminSearchUser();
}

async function adminGiveCoins(){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  const t = _adminGetTargetProfile();
  if(!t){ showToast('Выберите пользователя'); return; }
  const n = parseInt(document.getElementById('adminCoinAmount')?.value || '0', 10);
  if(!n){ showToast('Укажите сумму'); return; }
  t.profile.coins = Math.max(0, +(t.profile.coins||0) + n);
  await _adminSaveTarget(t);
  showToast((n>0?'+':'' ) + n + ' CC');
}

async function adminGiveStars(){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  const t = _adminGetTargetProfile();
  if(!t){ showToast('Выберите пользователя'); return; }
  const n = parseInt(document.getElementById('adminStarAmount')?.value || '0', 10);
  if(!n){ showToast('Укажите число'); return; }
  t.profile.stars = Math.max(0, +(t.profile.stars||0) + n);
  await _adminSaveTarget(t);
  showToast((n>0?'+':'' ) + n + ' ★');
}

async function adminToggleVerified(){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  const t = _adminGetTargetProfile();
  if(!t){ showToast('Выберите пользователя'); return; }
  t.profile.verified = !t.profile.verified;
  await _adminSaveTarget(t);
  showToast(t.profile.verified ? 'Галочка выдана ✓' : 'Галочка снята');
}

async function adminGivePremium(days){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  const t = _adminGetTargetProfile();
  if(!t){ showToast('Выберите пользователя'); return; }
  t.profile.premium = true;
  t.profile.premiumUntil = Date.now() + days * 86400000;
  t.profile.badge = 'premium';
  await _adminSaveTarget(t);
  showToast('Premium на ' + days + ' дн.');
}

async function adminRevokePremium(){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  const t = _adminGetTargetProfile();
  if(!t){ showToast('Выберите пользователя'); return; }
  t.profile.premium = false;
  t.profile.premiumUntil = 0;
  await _adminSaveTarget(t);
  showToast('Premium снят');
}

async function adminToggleAdmin(){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  const t = _adminGetTargetProfile();
  if(!t){ showToast('Выберите пользователя'); return; }
  t.profile.isAdmin = !t.profile.isAdmin;
  await _adminSaveTarget(t);
  showToast(t.profile.isAdmin ? 'Админ выдан' : 'Админ снят');
}

function adminSelfCoins(n){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  state.profile.coins = getCoins() + n;
  persistProfileToAccounts();
  updateCoinsUI();
  try{ renderAdminStats(); }catch(_){}
  try{ renderCoinsPage(true); }catch(_){}
  showToast('+' + n + ' CC');
}
function adminSelfStars(n){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  state.profile.stars = getStars() + n;
  persistProfileToAccounts();
  updateCoinsUI();
  renderProfile();
  showToast('+' + n + ' ★');
}

/* ---- Profile badges render patch helper ---- */
function profileBadgesHTML(){
  let h = '';
  if(isPremium()) h += ' <span class="premium-badge">PRO</span>';
  if(isVerified()) h += ' <span class="verified-badge" title="Подтверждён">✓</span>';
  if(getStars() > 0) h += ' <span class="star-badge" title="Звёзды">★' + getStars() + '</span>';
  return h;
}

/* ---- Real WebRTC via BroadcastChannel + WebSocket signaling ---- */
function callSignalingSend(payload){
  const msg = {
    ...payload,
    from: state.profile?.username || 'user',
    fromUserId: state.profile?.id || null,
    ts: Date.now(),
  };
  // Same-browser tabs
  if (bc) {
    try { bc.postMessage(msg); } catch (_) {}
  }
  // Cross-device via server WebSocket (conversation-scoped relay)
  if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        ...msg,
        conversationId: msg.conversationId || msg.chatId || null,
        targetId: msg.targetId || null,
      }));
    } catch (e) {
      console.warn('WS call signaling send failed', e);
    }
  }
}

async function ensureCallPc(video){
  if(callPc) return callPc;
  callPc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });
  callPc.onicecandidate = (ev) => {
    if(ev.candidate){
      callSignalingSend({ type: 'call_ice', chatId: callChatId, candidate: ev.candidate.toJSON() });
    }
  };
  callPc.ontrack = (ev) => {
    const remoteVid = document.getElementById('callRemoteVideo');
    if(remoteVid && ev.streams[0]){
      remoteVid.srcObject = ev.streams[0];
      remoteVid.style.display = 'block';
    }
    const pulse = document.getElementById('callPulseRing');
    if(pulse) pulse.style.display = 'none';
    document.getElementById('callAvatarFallback').style.display = 'none';
  };
  callPc.onconnectionstatechange = () => {
    const st = callPc?.connectionState;
    if(st === 'connected'){
      document.getElementById('callStatus').textContent = '00:00';
      callStartedAt = Date.now();
      clearInterval(callTimerInt);
      callTimerInt = setInterval(()=>{
        const s = Math.floor((Date.now()-callStartedAt)/1000);
        document.getElementById('callStatus').textContent =
          String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
      }, 500);
    }
    if(st === 'failed' || st === 'disconnected' || st === 'closed'){
      // soft end
    }
  };
  return callPc;
}

async function startCallReal(video){
  const chatId = state.currentChatId;
  if(!chatId){ showToast('Откройте чат'); return; }
  const chat = state.chats[chatId];
  if(chat?.isChannel){ showToast('В каналы нельзя звонить'); return; }
  if(chat?.isGroup){ showToast('Групповые звонки скоро'); return; }
  const contact = getContact(chat?.contactId || chatId);
  callIsVideo = !!video;
  callMuted = false;
  callCamOff = false;
  callChatId = chatId;
  callRole = 'caller';
  pendingOffer = null;
  iceBuf = [];

  document.getElementById('callName').textContent = contact.name;
  document.getElementById('callStatus').textContent = 'Вызов…';
  document.getElementById('callAvatarFallback').textContent = contact.initials || '?';
  document.getElementById('callAvatarFallback').style.display = video ? 'none' : 'flex';
  const pulse = document.getElementById('callPulseRing');
  if(pulse) pulse.style.display = video ? 'none' : 'flex';
  document.getElementById('callCamBtn').style.display = video ? 'flex' : 'none';
  document.getElementById('callLocalVideo').style.display = video ? 'block' : 'none';
  document.getElementById('callRemoteVideo').style.display = video ? 'block' : 'none';
  document.getElementById('callOverlay').classList.add('active');

  try{
    callStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  }catch(err){
    endCallReal();
    showModal(video ? 'Нет доступа к камере' : 'Нет доступа к микрофону',
      'Разрешите доступ в настройках браузера для звонков.');
    return;
  }

  const localVid = document.getElementById('callLocalVideo');
  if(video && localVid) localVid.srcObject = callStream;

  await ensureCallPc(video);
  callStream.getTracks().forEach(t => callPc.addTrack(t, callStream));

  // Persist call on server (broadcasts call-initiated to conversation members)
  try {
    if (typeof initiateCall === 'function') {
      const callType = video ? 'video' : 'audio';
      const serverCall = await initiateCall(chatId, callType);
      if (serverCall && serverCall.id) window._activeServerCallId = serverCall.id;
    }
  } catch (e) {
    console.warn('Server call register failed (continuing with P2P signaling)', e.message);
  }

  const offer = await callPc.createOffer();
  await callPc.setLocalDescription(offer);
  callSignalingSend({ type: 'call_offer', chatId, sdp: offer, video, from: state.profile.username });
  if(navigator.vibrate) navigator.vibrate([20,40,20]);
}

async function handleCallOffer(d){
  if(callPc && callRole === 'caller') return; // busy
  pendingOffer = d;
  pendingOfferFrom = d.from;
  callChatId = d.chatId;
  callIsVideo = !!d.video;
  const contact = getContact(state.chats[d.chatId]?.contactId || d.chatId);
  document.getElementById('incomingCallName').textContent = contact.name || d.from || 'Звонок';
  document.getElementById('incomingCallType').textContent = d.video ? 'Видеозвонок' : 'Аудиозвонок';
  const av = document.getElementById('incomingCallAvatar');
  if(av){ av.textContent = (contact.initials || '?'); }
  document.getElementById('incomingCallBanner').classList.add('show');
  if(navigator.vibrate) navigator.vibrate([80,40,80,40,80]);
}

async function acceptIncomingCall(){
  document.getElementById('incomingCallBanner').classList.remove('show');
  if(!pendingOffer) return;
  const d = pendingOffer;
  callRole = 'callee';
  callChatId = d.chatId;
  callIsVideo = !!d.video;
  callMuted = false;
  callCamOff = false;

  const contact = getContact(state.chats[d.chatId]?.contactId || d.chatId);
  document.getElementById('callName').textContent = contact.name || d.from;
  document.getElementById('callStatus').textContent = 'Соединение…';
  document.getElementById('callAvatarFallback').textContent = contact.initials || '?';
  document.getElementById('callAvatarFallback').style.display = callIsVideo ? 'none' : 'flex';
  document.getElementById('callCamBtn').style.display = callIsVideo ? 'flex' : 'none';
  document.getElementById('callLocalVideo').style.display = callIsVideo ? 'block' : 'none';
  document.getElementById('callRemoteVideo').style.display = callIsVideo ? 'block' : 'none';
  document.getElementById('callOverlay').classList.add('active');

  try{
    callStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callIsVideo ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  }catch(err){
    rejectIncomingCall();
    showModal('Нет доступа', 'Разрешите микрофон/камеру');
    return;
  }
  const localVid = document.getElementById('callLocalVideo');
  if(callIsVideo && localVid) localVid.srcObject = callStream;

  await ensureCallPc(callIsVideo);
  callStream.getTracks().forEach(t => callPc.addTrack(t, callStream));

  await callPc.setRemoteDescription(new RTCSessionDescription(d.sdp));
  // flush ice
  for(const c of iceBuf){
    try{ await callPc.addIceCandidate(new RTCIceCandidate(c)); }catch(_){}
  }
  iceBuf = [];
  const answer = await callPc.createAnswer();
  await callPc.setLocalDescription(answer);
  callSignalingSend({ type: 'call_answer', chatId: callChatId, sdp: answer });
  pendingOffer = null;
}

function rejectIncomingCall(){
  document.getElementById('incomingCallBanner').classList.remove('show');
  if(pendingOffer){
    callSignalingSend({ type: 'call_reject', chatId: pendingOffer.chatId });
  }
  pendingOffer = null;
}

async function handleCallAnswer(d){
  if(!callPc || callRole !== 'caller') return;
  try{
    await callPc.setRemoteDescription(new RTCSessionDescription(d.sdp));
    for(const c of iceBuf){
      try{ await callPc.addIceCandidate(new RTCIceCandidate(c)); }catch(_){}
    }
    iceBuf = [];
    document.getElementById('callStatus').textContent = 'Соединено';
  }catch(e){ console.warn('answer error', e); }
}

async function handleCallIce(d){
  if(!d.candidate) return;
  if(callPc && callPc.remoteDescription){
    try{ await callPc.addIceCandidate(new RTCIceCandidate(d.candidate)); }catch(_){}
  } else {
    iceBuf.push(d.candidate);
  }
}

function endCallReal(){
  clearInterval(callTimerInt);
  const durationSec = callStartedAt ? Math.floor((Date.now() - callStartedAt) / 1000) : 0;
  if(callStream){ callStream.getTracks().forEach(t=>t.stop()); callStream = null; }
  if(callPc){ try{ callPc.close(); }catch(_){} callPc = null; }
  const localVid = document.getElementById('callLocalVideo');
  const remoteVid = document.getElementById('callRemoteVideo');
  if(localVid) localVid.srcObject = null;
  if(remoteVid) remoteVid.srcObject = null;
  document.getElementById('callOverlay')?.classList.remove('active');
  document.getElementById('incomingCallBanner')?.classList.remove('show');
  if(callChatId) callSignalingSend({ type: 'call_end', chatId: callChatId });
  if (window._activeServerCallId && typeof endCallOnServer === 'function') {
    endCallOnServer(window._activeServerCallId, durationSec);
    window._activeServerCallId = null;
  }
  callChatId = null;
  callRole = null;
  pendingOffer = null;
  iceBuf = [];
  callStartedAt = 0;
}

// Override global call API
window.startCall = function(video){
  const chat = state.chats[state.currentChatId];
  if(chat?.isGroup){
    showToast('Групповые звонки скоро');
    return;
  }
  return startCallReal(video);
};
window.endCall = endCallReal;
window.acceptCall = function(){
  if (typeof acceptIncomingCall === 'function') return acceptIncomingCall();
};
window.rejectCall = function(){
  if (typeof rejectIncomingCall === 'function') return rejectIncomingCall();
};




/* ========== ADMIN PASSWORD GATE ========== */
// Password is checked on the server (/api/admin/unlock). Never ship secrets in the client bundle.
let adminUnlocked = false;
let adminPanelToken = null;
try {
  adminUnlocked = sessionStorage.getItem('chiper_admin_ok') === '1';
  adminPanelToken = sessionStorage.getItem('chiper_admin_token') || null;
} catch(_){}

function isAdminUnlocked(){
  return !!adminUnlocked || isAdminUserByAccount();
}
function isAdminUserByAccount(){
  const p = state.profile || {};
  if(p.isAdmin === false) return false;
  const email = (p.email || '').toLowerCase().trim();
  const u = (p.username || '').replace(/^@/,'').toLowerCase();
  if(typeof ADMIN_EMAILS !== 'undefined' && ADMIN_EMAILS.includes(email)) return true;
  if(typeof ADMIN_USERNAMES !== 'undefined' && ADMIN_USERNAMES.includes(u)) return true;
  if(p.isAdmin) return true;
  return false;
}
// Override isAdminUser to include password unlock
function isAdminUser(){
  return isAdminUnlocked();
}
async function tryUnlockAdmin(){
  const input = document.getElementById('adminPassInput');
  const err = document.getElementById('adminPassError');
  const pass = (input?.value || '').trim();
  if (!pass) {
    if (err) { err.textContent = 'Введите пароль'; err.classList.add('show'); }
    return;
  }
  try {
    const data = await postJson('/api/admin/unlock', { password: pass });
    if (!data || !data.ok) throw new Error(data?.error || 'Неверный пароль');
    adminUnlocked = true;
    adminPanelToken = data.token || null;
    try {
      sessionStorage.setItem('chiper_admin_ok', '1');
      if (adminPanelToken) sessionStorage.setItem('chiper_admin_token', adminPanelToken);
    } catch (_) {}
    if (err) { err.classList.remove('show'); err.textContent = ''; }
    if (input) input.value = '';
    showAdminPanelUnlocked();
    showToast('Админ-доступ открыт');
    if (navigator.vibrate) navigator.vibrate([15, 30, 15]);
  } catch (e) {
    if (err) { err.textContent = e.message || 'Неверный пароль'; err.classList.add('show'); }
    showToast(e.message || 'Неверный пароль');
    if (input) { input.value = ''; input.focus(); }
  }
}
function lockAdminPanel(){
  adminUnlocked = false;
  adminPanelToken = null;
  try {
    sessionStorage.removeItem('chiper_admin_ok');
    sessionStorage.removeItem('chiper_admin_token');
  } catch(_){}
  const gate = document.getElementById('adminLockGate');
  const content = document.getElementById('adminPanelContent');
  if(gate) gate.style.display = '';
  if(content) content.style.display = 'none';
  showToast('Админ-сессия закрыта');
  go('settings');
}
function renderAdminGate(){
  if(isAdminUnlocked()){
    showAdminPanelUnlocked();
    try{ renderAdminStats(); }catch(_){}
  } else {
    const gate = document.getElementById('adminLockGate');
    const content = document.getElementById('adminPanelContent');
    if(gate) gate.style.display = '';
    if(content) content.style.display = 'none';
    setTimeout(()=> document.getElementById('adminPassInput')?.focus(), 120);
  }
}

/* ========== CHIPER COIN PAGE ========== */
function ensureCoinTx(){
  if(!state.coinTx) state.coinTx = [];
}
function pushCoinTx(title, amount, sub){
  ensureCoinTx();
  state.coinTx.unshift({
    id: 'tx_' + Date.now().toString(36),
    title, amount, sub: sub || '', ts: Date.now()
  });
  if(state.coinTx.length > 50) state.coinTx = state.coinTx.slice(0, 50);
  try{ saveMeta(); }catch(_){}
}
function giftCoinsSelf(){
  const key = 'chiper_daily_gift_' + (state.profile?.uid || state.profile?.email || 'x');
  const today = new Date().toISOString().slice(0,10);
  try{
    if(localStorage.getItem(key) === today){
      showToast('Подарок уже получен сегодня');
      return;
    }
    localStorage.setItem(key, today);
  }catch(_){}
  state.profile.coins = getCoins() + 100;
  persistProfileToAccounts();
  pushCoinTx('Ежедневный подарок', 100, 'Бонус за вход');
  updateCoinsUI();
  renderCoinsPage(true);
  showToast('+100 CC · ежедневный бонус');
}

/* ========== CUSTOMIZATION: wallpaper / font / radius / status ========== */
function setChatWallpaper(name){
  if(!state.settings) state.settings = {};
  state.settings.wallpaper = name || 'default';
  applyChatWallpaper();
  saveMeta();
  document.querySelectorAll('#wallpaperPicker .wp-swatch').forEach(el=>{
    el.classList.toggle('active', el.dataset.wp === state.settings.wallpaper);
  });
  showToast('Обои: ' + name);
}
function applyChatWallpaper(){
  const msg = document.getElementById('messages');
  if(!msg) return;
  const wp = state.settings?.wallpaper || 'default';
  ['wp-default','wp-soft','wp-dots','wp-grid','wp-sunset','wp-ocean','wp-mint'].forEach(c => msg.classList.remove(c));
  msg.classList.add('wp-' + wp);
}
function setFontSize(size){
  if(!state.settings) state.settings = {};
  state.settings.fontSize = size || 'md';
  applyFontSize();
  saveMeta();
  document.querySelectorAll('#fontSizePicker .font-size-btn').forEach(el=>{
    el.classList.toggle('active', el.dataset.fs === state.settings.fontSize);
  });
  showToast(size === 'sm' ? 'Мелкий шрифт' : size === 'lg' ? 'Крупный шрифт' : 'Обычный шрифт');
}
function applyFontSize(){
  document.body.classList.remove('font-sm','font-lg');
  const s = state.settings?.fontSize || 'md';
  if(s === 'sm') document.body.classList.add('font-sm');
  if(s === 'lg') document.body.classList.add('font-lg');
}
function setBubbleRadius(r){
  if(!state.settings) state.settings = {};
  state.settings.bubbleRadius = r || 'default';
  applyBubbleRadius();
  saveMeta();
  document.querySelectorAll('#radiusPicker .radius-btn').forEach(el=>{
    el.classList.toggle('active', el.dataset.r === state.settings.bubbleRadius);
  });
  showToast(r === 'sharp' ? 'Острые углы' : r === 'round' ? 'Круглые пузырьки' : 'Обычные углы');
}
function applyBubbleRadius(){
  document.body.classList.remove('radius-sharp','radius-round');
  const r = state.settings?.bubbleRadius || 'default';
  const root = document.documentElement;
  if(r === 'sharp'){
    document.body.classList.add('radius-sharp');
    root.style.setProperty('--bubble-out-radius', '10px');
    root.style.setProperty('--bubble-out-tail', '2px');
  } else if(r === 'round'){
    document.body.classList.add('radius-round');
    root.style.setProperty('--bubble-out-radius', '28px');
    root.style.setProperty('--bubble-out-tail', '12px');
  } else {
    // restore from current bubble style
    try{ applyBubbleStyle(); }catch(_){}
  }
}
function saveCustomStatus(){
  const val = (document.getElementById('customStatusInput')?.value || '').trim().slice(0,40);
  if(!state.profile) state.profile = {};
  state.profile.customStatus = val;
  persistProfileToAccounts();
  try{ renderProfile(); }catch(_){}
  showToast(val ? 'Статус сохранён' : 'Статус очищен');
}
function applyAllCustomUI(){
  applyChatWallpaper();
  applyFontSize();
  applyBubbleRadius();
  const inp = document.getElementById('customStatusInput');
  if(inp && state.profile) inp.value = state.profile.customStatus || '';
  document.querySelectorAll('#wallpaperPicker .wp-swatch').forEach(el=>{
    el.classList.toggle('active', el.dataset.wp === (state.settings?.wallpaper || 'default'));
  });
  document.querySelectorAll('#fontSizePicker .font-size-btn').forEach(el=>{
    el.classList.toggle('active', el.dataset.fs === (state.settings?.fontSize || 'md'));
  });
  document.querySelectorAll('#radiusPicker .radius-btn').forEach(el=>{
    el.classList.toggle('active', el.dataset.r === (state.settings?.bubbleRadius || 'default'));
  });
}



/* ========== ADMIN PANEL ENHANCED ========== */
function switchAdminTab(tab){
  document.querySelectorAll('.admin-tab').forEach(t=> t.classList.toggle('active', t.dataset.tab===tab));
  document.querySelectorAll('.admin-pane').forEach(p=> p.classList.remove('active'));
  const pane = document.getElementById('adminPane' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if(pane) pane.classList.add('active');
  if(tab==='system' || tab==='economy') renderAdminStats();
  if(tab==='security') loadAdminSecurityStats();
}
function renderAdminStats(){
  let users = 0;
  try{ users = Object.keys(loadAccounts()||{}).length; }catch(_){}
  const chats = Object.keys(state.chats||{}).length;
  let msgs = 0;
  Object.values(state.chats||{}).forEach(c=> msgs += (c.messages||[]).length);
  const set = (id,v)=>{ const el=document.getElementById(id); if(el) el.textContent = v; };
  set('admStatUsers', users);
  set('admStatChats', chats);
  set('admStatMsgs', msgs);
  set('admStatCoins', getCoins());
  set('admAccCount', users);
  set('admDbStatus', (typeof db!=='undefined' && db) ? 'OK' : 'память');
  // ping server health
  fetch('/api/health').then(r=>r.json()).then(d=>{
    set('admServerStatus', d.ok ? ('OK · ws '+(d.ws||0)) : 'ошибка');
  }).catch(()=> set('admServerStatus', 'офлайн'));
}

async function adminApi(path, method, body){
  const headers = { 'Content-Type': 'application/json' };
  try {
    const email = (state.profile?.email || '').toLowerCase();
    if(email){
      const tk = (loadAccounts()[email] || {}).token;
      if(tk) headers['Authorization'] = 'Bearer ' + tk;
    }
  } catch(_){}
  // Prefer short-lived admin panel token from /api/admin/unlock
  if (adminPanelToken) headers['Authorization'] = 'Bearer ' + adminPanelToken;
  else if (typeof ADMIN_SECRET_CLIENT !== 'undefined' && ADMIN_SECRET_CLIENT) headers['x-admin-secret'] = ADMIN_SECRET_CLIENT;
  const res = await fetch(path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || ('HTTP '+res.status));
  return data;
}

async function loadAdminSecurityStats(){
  try{
    const d = await adminApi('/api/admin/stats');
    const set = (id,v)=>{ const el=document.getElementById(id); if(el) el.textContent = v; };
    set('admSecBlocked', d.security?.blockedRequests ?? 0);
    set('admSecRate', d.security?.rateLimited ?? 0);
    set('admSecWs', d.wsClients ?? 0);
    set('admSecUptime', d.uptimeSec ?? 0);
    set('admBannedIpsCount', (d.bannedIPs||[]).length);
    const list = document.getElementById('admBannedIpsList');
    if(list) list.textContent = (d.bannedIPs||[]).length ? d.bannedIPs.join(', ') : 'нет';
    set('admServerStatus', 'OK · up '+(d.uptimeSec||0)+'s');
  }catch(e){
    const list = document.getElementById('admBannedIpsList');
    if(list) list.textContent = 'Сервер недоступен: ' + (e.message||'');
  }
}

async function adminBanIp(){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  const ip = document.getElementById('adminBanIpInput')?.value?.trim();
  if(!ip){ showToast('Введите IP'); return; }
  try{
    await adminApi('/api/admin/ban-ip', 'POST', { ip });
    showToast('IP забанен: ' + ip);
    loadAdminSecurityStats();
  }catch(e){ showToast(e.message||'Ошибка'); }
}

async function adminUnbanIp(){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  const ip = document.getElementById('adminBanIpInput')?.value?.trim();
  if(!ip){ showToast('Введите IP'); return; }
  try{
    await adminApi('/api/admin/unban-ip', 'POST', { ip });
    showToast('Бан снят: ' + ip);
    loadAdminSecurityStats();
  }catch(e){ showToast(e.message||'Ошибка'); }
}

async function adminClearRateLimits(){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  try{
    await adminApi('/api/admin/clear-rate-limits', 'POST', {});
    showToast('Rate-limit сброшен');
    loadAdminSecurityStats();
  }catch(e){ showToast(e.message||'Ошибка'); }
}

async function adminBlockUser(blocked){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  const t = typeof _adminGetTargetProfile === 'function' ? _adminGetTargetProfile() : null;
  const userId = t?.profile?.id || t?.id;
  if(!userId){ showToast('Выберите пользователя (нужен id)'); return; }
  try{
    await adminApi('/api/admin/block-user', 'POST', { userId, blocked: !!blocked });
    if(t.profile) t.profile.blocked = !!blocked;
    showToast(blocked ? 'Пользователь заблокирован' : 'Разблокирован');
  }catch(e){ showToast(e.message||'Ошибка'); }
}
function adminSelfPremium(days){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  state.profile.premium = true;
  state.profile.premiumUntil = Date.now() + days * 86400000;
  state.profile.badge = 'premium';
  persistProfileToAccounts();
  renderProfile();
  updateCoinsUI();
  renderAdminStats();
  showToast('Premium на ' + days + ' дн.');
}
function adminGrantAllCoins(n){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  try{
    const accounts = loadAccounts();
    let cnt = 0;
    for(const [email, a] of Object.entries(accounts)){
      if(!a.profile) a.profile = {};
      a.profile.coins = Math.max(0, +(a.profile.coins||0) + n);
      cnt++;
      if(state.profile?.email === email) state.profile.coins = a.profile.coins;
    }
    saveAccounts(accounts);
    persistProfileToAccounts();
    updateCoinsUI();
    renderAdminStats();
    showToast('+' + n + ' CC × ' + cnt + ' акк.');
  }catch(e){ showToast('Ошибка'); }
}
function adminResetOwnCoins(){
  if(!isAdminUser()){ showToast('Нет доступа'); return; }
  if(!confirm('Обнулить свои Chiper Coin?')) return;
  state.profile.coins = 0;
  persistProfileToAccounts();
  updateCoinsUI();
  renderAdminStats();
  try{ renderCoinsPage(); }catch(_){}
  showToast('Баланс обнулён');
}

/* patch showAdminPanelUnlocked to refresh stats */
const _showAdminUnlockedOrig = typeof showAdminPanelUnlocked === 'function' ? showAdminPanelUnlocked : null;
function showAdminPanelUnlocked(){
  const gate = document.getElementById('adminLockGate');
  const content = document.getElementById('adminPanelContent');
  if(gate) gate.style.display = 'none';
  if(content) content.style.display = '';
  updateCoinsUI();
  renderAdminStats();
  switchAdminTab('users');
}

/* Enhanced coin buy with animation */
function spawnCoinBurst(x, y){
  const colors = ['#F59E0B','#EAB308','#FBBF24','#FDE68A','#fff'];
  for(let i=0;i<8;i++){
    const d = document.createElement('div');
    d.className = 'coin-confetti';
    d.style.left = (x + (Math.random()*40-20)) + 'px';
    d.style.top = (y + (Math.random()*20-10)) + 'px';
    d.style.background = colors[i%colors.length];
    d.style.animationDelay = (i*30) + 'ms';
    document.body.appendChild(d);
    setTimeout(()=> d.remove(), 950);
  }
}
function buyCoinPack(base, bonus, el){
  // Покупка монет только через админку — обычным пользователям недоступно
  const isAdmin = !!(state.profile && (state.profile.isAdmin || state.profile.admin));
  if(!isAdmin){
    showModalUnavailable();
    return;
  }
  const total = base + (bonus || 0);
  if(el && el.classList){
    el.classList.remove('buying');
    void el.offsetWidth;
    el.classList.add('buying');
    const r = el.getBoundingClientRect();
    spawnCoinBurst(r.left + r.width/2, r.top + r.height/2);
  }
  state.profile.coins = getCoins() + total;
  persistProfileToAccounts();
  pushCoinTx('Покупка пакета', total, base + (bonus ? ' + ' + bonus + ' бонус' : ' монет'));
  updateCoinsUI();
  renderCoinsPage(true);
  showToast('+' + total + ' Chiper Coin');
  if(navigator.vibrate) navigator.vibrate([12,20,12]);
}

function showModalUnavailable(){
  if(typeof showModal === 'function'){
    showModal('Временно недоступно', 'Покупка Chiper Coin сейчас недоступна. Монеты выдаются только администратором.');
  } else {
    const overlay = document.getElementById('modalOverlay');
    const title = document.getElementById('modalTitle');
    const text = document.getElementById('modalText');
    if(title) title.textContent = 'Временно недоступно';
    if(text) text.textContent = 'Покупка Chiper Coin сейчас недоступна. Монеты выдаются только администратором.';
    if(overlay) overlay.classList.add('show');
  }
}
function renderCoinsPage(pop){
  const bal = getCoins();
  const big = document.getElementById('coinsBalanceBig');
  if(big){
    big.textContent = bal.toLocaleString('ru-RU');
    if(pop){
      big.classList.remove('pop');
      void big.offsetWidth;
      big.classList.add('pop');
    }
  }
  const stars = document.getElementById('coinsStarsBadge');
  if(stars) stars.textContent = '★ ' + getStars();
  const pro = document.getElementById('coinsPremiumBadge');
  if(pro) pro.style.display = isPremium() ? '' : 'none';
  const costHint = document.getElementById('coinsPremiumCostHint');
  if(costHint) costHint.textContent = selectedPremiumPlan === 'year' ? '999 CC / год' : '299 CC / мес';
  ensureCoinTx();
  const list = document.getElementById('coinTxList');
  if(!list) return;
  if(!state.coinTx.length){
    list.innerHTML = '<div class="empty-state" style="padding:24px 12px;"><div class="desc">Пока нет операций</div></div>';
    return;
  }
  list.innerHTML = state.coinTx.slice(0, 30).map((tx,i) => {
    const d = new Date(tx.ts);
    const when = d.toLocaleDateString('ru-RU', {day:'numeric', month:'short'}) + ' · ' + d.toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'});
    const cls = tx.amount >= 0 ? 'plus' : 'minus';
    const sign = tx.amount >= 0 ? '+' : '';
    const icon = tx.amount >= 0 ? '🪙' : '📤';
    return `<div class="tx-row glass r20" style="animation-delay:${Math.min(i*40,200)}ms">
      <div class="tx-icon">${icon}</div>
      <div style="flex:1;min-width:0;">
        <div class="tx-title">${escapeHtml(tx.title)}</div>
        <div class="tx-sub">${escapeHtml(tx.sub || when)}</div>
      </div>
      <div class="tx-amount ${cls}">${sign}${tx.amount} CC</div>
    </div>`;
  }).join('');
}

/* Perf: throttle deviceorientation parallax */
(function(){
  let last = 0;
  const handler = (e)=>{
    const now = performance.now();
    if(now - last < 80) return;
    last = now;
    if(document.hidden) return;
    const x = (e.gamma||0)/45, y = (e.beta||0)/45;
    const o1 = document.querySelector('.orb1');
    const o2 = document.querySelector('.orb2');
    if(o1) o1.style.transform = `translate(${x*12}px, ${y*8}px)`;
    if(o2) o2.style.transform = `translate(${-x*10}px, ${-y*6}px)`;
  };
  // remove heavy previous listeners by replacing with passive throttled
  window.addEventListener('deviceorientation', handler, {passive:true});
})();


/* ========== INIT ========== */
(async function init(){
  // Start locked until Firebase confirms a real profile
  state.loggedIn = false;
  document.body.classList.remove('authed');
  document.querySelectorAll('.screen.active').forEach(s => s.classList.remove('active'));
  const loginScreen = document.getElementById('screen-login');
  if(loginScreen) loginScreen.classList.add('active');

  try{
    /* local mode — no Firebase */
    await loadState();
  }catch(e){
    console.error('loadState failed', e);
    showToast('Ошибка загрузки данных');
    state.loggedIn = false;
    document.body.classList.remove('authed');
    go('login');
  }

  // Only enter the app when we have a complete profile
  if(state.loggedIn && state.profile?.uid && state.profile?.username){
    document.body.classList.add('authed');
    document.getElementById('screen-login')?.classList.remove('active');
    document.getElementById('screen-chats')?.classList.add('active');
    try{ renderChatList(); }catch(_){}
  } else if(!window._pendingReg){
    document.body.classList.remove('authed');
    document.querySelectorAll('.screen.active').forEach(s => s.classList.remove('active'));
    if(loginScreen) loginScreen.classList.add('active');
  }

  if(state.profile){
    if(typeof state.profile.coins !== 'number') state.profile.coins = state.profile.coins || 0;
    if(typeof state.profile.stars !== 'number') state.profile.stars = state.profile.stars || 0;
  }
  if(state.loggedIn && state.profile?.username){
    try{ renderProfile(); }catch(_){}
  }
  applyBubbleStyle();
  applyCompact();
  try{ applyAllCustomUI(); }catch(_){}
  try{ updateCoinsUI(); }catch(_){}
  setInterval(applyThemeSchedule, 60 * 1000);
  // position nav bubbles (no pop on first paint) — only when authed
  requestAnimationFrame(()=>{
    if(!document.body.classList.contains('authed')) return;
    document.querySelectorAll('.bottom-nav').forEach(nav=>{
      const active = nav.querySelector('.nav-item.active') || nav.querySelector('.nav-item');
      if(active){
        active._navInit = true;
        moveNavBubble(active);
      }
    });
  });
})();

// ========== WEBSOCKET REALTIME & FEATURES ==========
let ws = null;
let wsReconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    wsReconnectAttempts = 0;
    if (state.profile && state.profile.id) {
      ws.send(JSON.stringify({
        type: 'auth',
        userId: state.profile.id,
        email: state.profile.email,
        token: loadAccounts()[state.profile.email.toLowerCase()]?.token
      }));
    }
    console.log('✅ WebSocket connected');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWebSocketMessage(msg);
    } catch (e) {
      console.error('WebSocket parse error:', e);
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    attemptWebSocketReconnect();
  };
}

function attemptWebSocketReconnect() {
  if (wsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn('Max WebSocket reconnect attempts reached');
    return;
  }
  wsReconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
  setTimeout(connectWebSocket, delay);
}

function handleWebSocketMessage(msg) {
  if (msg.type === 'new-message') {
    const convId = msg.data?.conversation_id;
    const localId =
      (typeof resolveLocalChatId === 'function' && convId ? resolveLocalChatId(convId) : null) ||
      convId;
    const chat = (localId && state.chats[localId]) || (convId && state.chats[convId]);
    if (chat && msg.data) {
      const newMsg = {
        id: msg.data.id,
        text: msg.data.content || '',
        ts: msg.data.created_at ? new Date(msg.data.created_at).getTime() : Date.now(),
        from: msg.data.sender_id,
        status: 'sent',
        out: msg.data.sender_id === state.profile?.id,
        serverId: msg.data.id,
      };
      if (!chat.messages.some((m) => m.id === newMsg.id || m.serverId === newMsg.id)) {
        chat.messages.push(newMsg);
        chat.lastTs = newMsg.ts;
        try {
          persistChatMeta(localId || convId);
        } catch (_) {}
      }
      const chatScreen = document.getElementById('screen-chat');
      if (
        chatScreen &&
        chatScreen.classList.contains('active') &&
        state.currentChatId &&
        (String(state.currentChatId) === String(localId) || String(state.currentChatId) === String(convId))
      ) {
        if (typeof renderMessages === 'function') renderMessages();
        else {
          const el = typeof createBubbleEl === 'function' ? createBubbleEl(newMsg) : null;
          const box = document.getElementById('messages');
          if (el && box) {
            box.appendChild(el);
            requestAnimationFrame(() => el.classList.add('show'));
            if (typeof scrollMessagesToBottom === 'function') scrollMessagesToBottom(true);
          }
        }
      }
      if (typeof renderChatsList === 'function') renderChatsList();
    }
  } else if (msg.type === 'e2ee-message') {
    // Instant delivery of encrypted DM from peer
    (async () => {
      try {
        const record = msg.data;
        if (!record || !record.chat_id || !record.id) return;
        const chatId = record.chat_id;
        const localId =
          (typeof resolveLocalChatId === 'function' ? resolveLocalChatId(chatId) : null) || chatId;
        let chat = state.chats[localId] || state.chats[chatId];
        if (!chat) {
          // Unknown chat — ignore for now (will appear on next full sync)
          return;
        }
        if (chat.messages && chat.messages.some((m) => m.id === record.id)) return;

        const peer =
          typeof peerFromDmId === 'function'
            ? peerFromDmId(localId || chatId)
            : normalizeUsername(record.sender_username);
        const peerPublicKey = await getPeerPublicKey(peer || record.sender_username);
        if (!peerPublicKey) {
          console.warn('e2ee-message: no peer public key');
          return;
        }
        const payload = await decryptChatPayload(record, peerPublicKey);
        const newMsg = {
          ...payload,
          id: payload.id || record.id,
          status: 'sent',
          from: normalizeUsername(record.sender_username),
          out:
            normalizeUsername(record.sender_username) ===
            normalizeUsername(state.profile?.username),
          ts: payload.ts || (record.created_at ? new Date(record.created_at).getTime() : Date.now()),
        };
        if (!chat.messages) chat.messages = [];
        chat.messages.push(newMsg);
        chat.lastTs = newMsg.ts;
        try {
          await persistChatMeta(localId || chatId);
        } catch (_) {}

        const chatScreen = document.getElementById('screen-chat');
        if (
          chatScreen &&
          chatScreen.classList.contains('active') &&
          state.currentChatId &&
          (String(state.currentChatId) === String(localId) || String(state.currentChatId) === String(chatId))
        ) {
          if (typeof renderMessages === 'function') renderMessages();
          else {
            const el = typeof createBubbleEl === 'function' ? createBubbleEl(newMsg) : null;
            const box = document.getElementById('messages');
            if (el && box) {
              box.appendChild(el);
              requestAnimationFrame(() => el.classList.add('show'));
              if (typeof scrollMessagesToBottom === 'function') scrollMessagesToBottom(true);
            }
          }
          if (navigator.vibrate) navigator.vibrate(12);
        }
        if (typeof renderChatsList === 'function') renderChatsList();
      } catch (e) {
        console.warn('e2ee-message handle failed', e);
      }
    })();
  } else if (msg.type === 'typing') {
    // Show typing in the active chat header / message list
    const convId = msg.conversationId || msg.conversation_id;
    if (convId && state.currentChatId && String(convId) !== String(state.currentChatId)) return;
    if (msg.userId && state.profile?.id && String(msg.userId) === String(state.profile.id)) return;

    const statusEl = document.getElementById('chatStatus');
    if (statusEl) {
      statusEl.textContent = 'печатает…';
      clearTimeout(window._typingTO);
      window._typingTO = setTimeout(() => {
        const st = state.onlineStatus && state.onlineStatus[state.currentChatId];
        statusEl.textContent = (st && st.online) ? 'в сети' : 'был(а) недавно';
      }, 3000);
    }

    const chatArea = document.getElementById('messages');
    if (chatArea && msg.userId) {
      let typingEl = chatArea.querySelector(`[data-typing-user="${msg.userId}"]`);
      if (!typingEl) {
        typingEl = document.createElement('div');
        typingEl.setAttribute('data-typing-user', msg.userId);
        typingEl.style.cssText = 'color:var(--text-secondary, #888); font-size:12px; margin:8px 12px; font-style:italic;';
        chatArea.appendChild(typingEl);
      }
      typingEl.textContent = 'печатает…';
      clearTimeout(typingEl._hideTimer);
      typingEl._hideTimer = setTimeout(() => {
        try { typingEl.remove(); } catch (_) {}
      }, 3000);
      try { chatArea.scrollTop = chatArea.scrollHeight; } catch (_) {}
    }
  } else if (
    msg.type === 'call_offer' || msg.type === 'call-offer' ||
    msg.type === 'call_answer' || msg.type === 'call-answer' ||
    msg.type === 'call_ice' || msg.type === 'ice-candidate' ||
    msg.type === 'call_reject' || msg.type === 'call_end'
  ) {
    // Ignore our own echoes
    if (msg.fromUserId && state.profile?.id && String(msg.fromUserId) === String(state.profile.id)) return;
    if (msg.from && state.profile?.username && msg.from === state.profile.username) return;

    if (msg.type === 'call_offer' || msg.type === 'call-offer') {
      if (typeof handleCallOffer === 'function') handleCallOffer({
        ...msg,
        chatId: msg.chatId || msg.conversationId,
        sdp: msg.sdp || msg.offer,
        video: !!msg.video,
        from: msg.from,
      });
    } else if (msg.type === 'call_answer' || msg.type === 'call-answer') {
      if (typeof handleCallAnswer === 'function') handleCallAnswer({
        ...msg,
        sdp: msg.sdp || msg.answer,
      });
    } else if (msg.type === 'call_ice' || msg.type === 'ice-candidate') {
      if (typeof handleCallIce === 'function') handleCallIce({
        candidate: msg.candidate || msg.ice,
      });
    } else if (msg.type === 'call_reject' || msg.type === 'call_end') {
      if (typeof endCallReal === 'function') endCallReal();
      else if (typeof window.endCall === 'function') window.endCall();
      showToast(msg.type === 'call_reject' ? 'Звонок отклонён' : 'Звонок завершён');
    }
  } else if (msg.type === 'call-initiated') {
    // Server-side call record — prefer SDP offer path when available
    if (msg.data && !pendingOffer) handleIncomingCall(msg.data);
  } else if (msg.type === 'message-receipt') {
    if (typeof ChiperMessages !== 'undefined' && ChiperMessages.handleMessageReceipt) {
      ChiperMessages.handleMessageReceipt(msg);
    }
  } else if (msg.type === 'user-status') {
    updateUserStatus(msg.userId, msg.status);
  } else if (msg.type === 'error') {
    console.error('WebSocket server error:', msg.message);
    if (msg.message === 'Token required' || msg.message === 'Invalid token') {
      wsReconnectAttempts = MAX_RECONNECT_ATTEMPTS;
      if (typeof state !== 'undefined' && state.loggedIn) {
        state.loggedIn = false;
        document.body.classList.remove('authed');
        if (typeof go === 'function') go('login');
        if (typeof showToast === 'function') showToast('Сессия истекла. Войдите снова.');
      }
    }
  }
}

function broadcastMessage(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data, userId: state.profile?.id }));
  }
}

// ========== SEARCH FUNCTIONALITY ==========
async function searchMessages(query, conversationId) {
  if (!query || !conversationId) return [];
  try {
    const res = await getJson(`/api/search?q=${encodeURIComponent(query)}&type=messages&conversation_id=${encodeURIComponent(conversationId)}`);
    return res.results || [];
  } catch (e) {
    console.error('Search error:', e);
    return [];
  }
}

async function searchProfiles(query) {
  if (!query || String(query).trim().length < 2) return [];
  try {
    const res = await getJson(getFunctionUrl('search') + `?q=${encodeURIComponent(query)}&type=profiles`);
    return Array.isArray(res.results) ? res.results : [];
  } catch (e) {
    console.error('Search error:', e);
    return [];
  }
}

async function checkUsername(username) {
  if (!username || username.length < 3) return null;
  try {
    const res = await getJson(`/api/check-username?username=${encodeURIComponent(username)}`);
    return res;
  } catch (e) {
    console.error('Username check error:', e);
    return null;
  }
}

function renderProfileCard(profile) {
  if (!profile) return '';
  const avatar = profile.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(profile.username || profile.name || 'User')}&background=7C3AED&color=fff`;
  const status = profile.status === 'online' ? '🟢' : '🔵';
  const verified = profile.verified ? '✅' : '';
  return `
    <div class="profile-card" style="display:flex; gap:12px; padding:12px; background:var(--glass); border-radius:12px; align-items:center; margin-bottom:8px;">
      <img src="${avatar}" style="width:40px; height:40px; border-radius:50%; object-fit:cover;">
      <div style="flex:1; min-width:0;">
        <div style="font-weight:600; font-size:14px;">
          ${profile.username || 'Unknown'} ${verified}
        </div>
        <div style="font-size:12px; color:var(--text-secondary);">
          ${profile.name || ''} ${status}
        </div>
      </div>
    </div>
  `;
}

// ========== CALLS FUNCTIONALITY ==========
async function initiateCall(conversationId, callType) {
  try {
    const res = await postJson('/api/calls', {
      conversation_id: conversationId,
      initiator_id: state.profile?.id,
      call_type: callType
    });
    broadcastMessage('call-initiated', res.call);
    return res.call;
  } catch (e) {
    console.error('Call init error:', e);
    showToast('Ошибка при инициировании звонка');
  }
}

function handleIncomingCall(call) {
  if (!call || call.initiator_id === state.profile?.id) return;
  const callType = call.call_type === 'video' ? 'видео' : 'голосовой';
  showToast(`Входящий ${callType} звонок`);

  // Remove any previous incoming-call modal
  try { document.getElementById('incomingCallModal')?.remove(); } catch (_) {}

  const modal = document.createElement('div');
  modal.id = 'incomingCallModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:10000;';
  modal.innerHTML = `
    <div style="background:var(--glass, #1e1e2e);padding:24px;border-radius:16px;min-width:260px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.4);">
      <div style="font-size:18px;margin-bottom:8px;">📞 Входящий ${callType} звонок</div>
      <div style="opacity:.7;font-size:13px;margin-bottom:18px;">ID: ${String(call.id || '').slice(0, 8)}…</div>
      <div style="display:flex;gap:12px;justify-content:center;">
        <button type="button" id="btnAcceptCall" style="padding:10px 18px;border-radius:10px;border:none;background:#22c55e;color:#fff;font-weight:600;cursor:pointer;">Принять</button>
        <button type="button" id="btnRejectCall" style="padding:10px 18px;border-radius:10px;border:none;background:#ef4444;color:#fff;font-weight:600;cursor:pointer;">Отклонить</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const cleanup = () => { try { modal.remove(); } catch (_) {} };
  modal.querySelector('#btnAcceptCall')?.addEventListener('click', () => {
    cleanup();
    // If we already have an SDP offer, use WebRTC accept path; otherwise just mark server call accepted
    if (pendingOffer && typeof acceptIncomingCall === 'function') {
      acceptIncomingCall();
    } else if (typeof window.acceptCall === 'function') {
      window.acceptCall(call.id);
    } else {
      showToast('Ожидание сигнала звонка…');
    }
  });
  modal.querySelector('#btnRejectCall')?.addEventListener('click', () => {
    cleanup();
    if (typeof rejectIncomingCall === 'function') rejectIncomingCall();
    else if (typeof window.rejectCall === 'function') window.rejectCall(call.id);
    endCallOnServer(call.id, 0);
    showToast('Звонок отклонён');
  });
  // Auto-dismiss after 45s
  setTimeout(cleanup, 45000);
}

async function endCallOnServer(callId, durationSeconds) {
  if (!callId) return;
  try {
    await fetchJson(`/api/calls/${callId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'ended',
        ended_at: new Date().toISOString(),
        duration_seconds: durationSeconds || 0
      })
    });
  } catch (e) {
    console.error('End call error:', e);
  }
}

// ========== FILE UPLOAD ==========
async function uploadFile(file, conversationId, messageId) {
  try {
    if (!file) throw new Error('Нет файла');
    // Compress images client-side before upload
    if (file.type && file.type.startsWith('image/') && typeof ChiperCore !== 'undefined' && ChiperCore.compressImageFile) {
      try { file = await ChiperCore.compressImageFile(file); } catch (_) {}
    }
    const MAX_UPLOAD = 6 * 1024 * 1024; // 6 MB (matches server body limit ~8mb with base64 overhead)
    if (file.size > MAX_UPLOAD) {
      throw new Error('Файл слишком большой (макс. 6 МБ)');
    }
    if (typeof showToast === 'function') showToast('Загрузка файла…');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
      reader.readAsDataURL(file);
    });

    // postJson / fetchJson attach Authorization Bearer token automatically
    const result = await postJson('/api/file-upload', {
      file_name: file.name,
      file_size: file.size,
      file_type: file.type || null,
      conversation_id: conversationId || null,
      message_id: messageId || null,
      data: dataUrl, // base64 data-url → Supabase Storage on server
      url: dataUrl,
    });
    return result.file || result;
  } catch (e) {
    console.error('File upload error:', e);
    showToast('Ошибка загрузки файла: ' + (e.message || ''));
    return null;
  }
}

// ========== MESSAGE REACTIONS ==========
async function addReaction(messageId, emoji) {
  try {
    // Prefer server UUID if message was synced; skip Supabase for pure-local ids
    const chat = state.chats[state.currentChatId];
    const m = chat?.messages?.find((x) => x.id === messageId);
    const serverMsgId = (m && m.serverId) || messageId;
    const isUuid = typeof ChiperCore !== 'undefined' && ChiperCore.isUuid
      ? ChiperCore.isUuid(serverMsgId)
      : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(serverMsgId));
    if (!isUuid) {
      // Local-only reaction already applied in UI
      return { local: true, message_id: messageId, emoji };
    }
    const res = await postJson('/api/reactions', {
      message_id: serverMsgId,
      profile_id: state.profile?.id,
      emoji
    });
    return res.reaction;
  } catch (e) {
    console.error('Reaction error:', e);
  }
}

async function removeReaction(reactionId) {
  try {
    await fetchJson(`/api/reactions/${reactionId}`, { method: 'DELETE' });
  } catch (e) {
    console.error('Remove reaction error:', e);
  }
}

// ========== CONVERSATIONS ==========
async function loadConversations() {
  try {
    const res = await getJson(`/api/conversations?profile_id=${state.profile?.id}`);
    return res.conversations || [];
  } catch (e) {
    console.error('Load conversations error:', e);
    return [];
  }
}

async function createConversation(type, participantIds, name, description) {
  try {
    if (!type || !['direct', 'dm', 'group', 'channel'].includes(type)) {
      showToast('Неверный тип чата');
      return null;
    }

    // Normalize 'direct' to 'dm' for database
    const dbType = type === 'direct' ? 'dm' : type;

    if ((type === 'direct' || type === 'dm') && (!participantIds || participantIds.length !== 2)) {
      showToast('Личный чат должен быть с одним человеком');
      return null;
    }

    if ((type === 'group' || type === 'channel') && !name) {
      showToast('Название обязательно для группы/канала');
      return null;
    }

    if (name && name.length < 2) {
      showToast('Название должно быть минимум 2 символа');
      return null;
    }

    const myId = (typeof getMyProfileId === 'function' ? getMyProfileId() : null) || state.profile?.id || null;
    const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
    let parts = Array.isArray(participantIds) ? participantIds.filter((id) => isUuid(id)) : [];
    // Groups/channels may be created with only the creator (server always adds JWT user)
    if ((dbType === 'group' || dbType === 'channel') && parts.length === 0 && isUuid(myId)) {
      parts = [myId];
    }

    const payload = {
      type: dbType,
      name: name || null,
      description: description || null,
      participant_ids: parts,
      created_by: isUuid(myId) ? myId : undefined
    };

    const res = await postJson('/api/conversations', payload);
    return res.conversation || null;
  } catch (e) {
    console.error('Create conversation error:', e);
    showToast('Ошибка создания чата: ' + (e.message || 'unknown'));
    return null;
  }
}

// ========== NEW CHAT ENHANCED ==========
async function handleNewChatSearch(query) {
  if (!query || query.length < 1) {
    document.getElementById('userSearchResults').innerHTML = '';
    return;
  }

  const results = await searchProfiles(query);
  const resultsDiv = document.getElementById('userSearchResults');

  if (!Array.isArray(results) || results.length === 0) {
    resultsDiv.innerHTML = '<div style="padding:12px; color:var(--text-secondary); text-align:center;">Пользователь не найден</div>';
    return;
  }

  resultsDiv.innerHTML = results.map(profile => `
    <div class="profile-card" onclick="selectChatMember('${profile.id}', '${profile.username}')">
      ${renderProfileCard(profile)}
    </div>
  `).join('');
}

window.selectedChatMembers = [];

function selectChatMember(userId, username) {
  if (window.selectedChatMembers.includes(userId)) {
    window.selectedChatMembers = window.selectedChatMembers.filter(id => id !== userId);
  } else {
    window.selectedChatMembers.push(userId);
  }
  renderSelectedMembers();
}

function renderSelectedMembers() {
  const container = document.getElementById('selectedMembersContainer');
  if (!container) return;

  if (window.selectedChatMembers.length === 0) {
    container.innerHTML = '<div style="padding:12px; color:var(--text-secondary);">Не выбрано</div>';
    return;
  }

  container.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; gap:8px;">
      ${window.selectedChatMembers.map(id => `
        <div style="background:var(--primary); color:white; padding:6px 12px; border-radius:16px; font-size:12px; display:flex; align-items:center; gap:6px;">
          ${id.substring(0, 8)}...
          <span onclick="selectChatMember('${id}', '')" style="cursor:pointer; font-weight:bold;">×</span>
        </div>
      `).join('')}
    </div>
  `;
}

async function createNewChat() {
  const chatType = document.getElementById('chatTypeSelect')?.value || 'direct';
  const chatName = document.getElementById('chatNameInput')?.value?.trim() || '';
  const chatDescription = document.getElementById('chatDescInput')?.value?.trim() || '';

  if (chatType === 'direct') {
    if (window.selectedChatMembers.length !== 1) {
      showToast('Выберите ровно одного пользователя для личного чата');
      return;
    }
    const participants = [state.profile?.id, window.selectedChatMembers[0]];
    const chat = await createConversation('direct', participants);
    if (chat) {
      window.selectedChatMembers = [];
      document.getElementById('newChatModal').style.display = 'none';
      showToast('Чат создан!');
      await loadChats();
    }
  } else if (chatType === 'group' || chatType === 'channel') {
    if (!chatName || chatName.length < 3) {
      showToast('Название должно быть минимум 3 символа');
      return;
    }
    if (window.selectedChatMembers.length < 1) {
      showToast('Добавьте минимум одного участника');
      return;
    }
    const participants = [state.profile?.id, ...window.selectedChatMembers];
    const chat = await createConversation(chatType, participants, chatName, chatDescription);
    if (chat) {
      window.selectedChatMembers = [];
      document.getElementById('newChatModal').style.display = 'none';
      showToast(`${chatType === 'group' ? 'Группа' : 'Канал'} создан!`);
      await loadChats();
    }
  }
}

// ========== ONLINE STATUS ==========
function updateUserStatus(userId, status) {
  const profile = Object.values(state.accounts || {}).find(a => a.profile?.id === userId);
  if (profile) {
    profile.status = status;
  }
}

// ========== AUTO-SYNC MESSAGES ==========
async function syncMessages(conversationId) {
  try {
    const res = await getJson(`/api/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=50`);
    return res.messages || [];
  } catch (e) {
    console.error('Sync messages error:', e);
    return [];
  }
}

// ========== NEW CHAT UI FUNCTIONS ==========
window.groupMembers = [];
window.groupName = '';
window.groupDesc = '';
window.channelData = {};

function switchNewTab(tab) {
  document.getElementById('tabUsers').classList.toggle('active', tab === 'users');
  document.getElementById('tabGroup').classList.toggle('active', tab === 'group');
  document.getElementById('tabChannel').classList.toggle('active', tab === 'channel');

  document.getElementById('newUsersPane').style.display = tab === 'users' ? '' : 'none';
  document.getElementById('newGroupPane').style.display = tab === 'group' ? '' : 'none';
  document.getElementById('newChannelPane').style.display = tab === 'channel' ? '' : 'none';
}

function getMyProfileId() {
  return state.profile?.id || state.profile?.uid || null;
}

function normalizePeerUsername(u) {
  return String(u || '').trim().replace(/^@+/, '').toLowerCase();
}

async function searchUsersByUsername() {
  const list = document.getElementById('contactList');
  if (!list) return;

  const raw = document.getElementById('contactSearch')?.value?.trim() || '';
  const query = raw.replace(/^@+/, '').trim();
  if (query.length < 1) {
    list.innerHTML = `<div style="text-align:center;padding:32px 16px;color:var(--text-secondary);font-size:14px;">
      Введите @username чтобы найти или начать чат
    </div>`;
    return;
  }

  list.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-secondary);">Поиск…</div>';

  const seen = new Set();
  const results = [];

  try { rebuildUsersIndex(); } catch (_) {}
  Object.values(state.usersIndex || {}).forEach((u) => {
    const un = normalizePeerUsername(u.username);
    const name = String(u.name || '').toLowerCase();
    const id = String(u.id || u.uid || un);
    if (!un && !name) return;
    if (!(un.includes(query.toLowerCase()) || name.includes(query.toLowerCase()))) return;
    if (seen.has(id) || seen.has(un)) return;
    seen.add(id); seen.add(un);
    results.push({
      id,
      username: un ? '@' + un : '',
      name: u.name || un,
      avatar: u.avatar || null,
      verified: !!u.verified,
      status: u.status || 'offline',
    });
  });

  if (query.length >= 2) {
    try {
      const remote = await searchProfiles(query);
      (Array.isArray(remote) ? remote : []).forEach((p) => {
        const un = normalizePeerUsername(p.username);
        const id = String(p.id || un);
        if (seen.has(id) || (un && seen.has(un))) {
          const idx = results.findIndex((r) => r.id === id || normalizePeerUsername(r.username) === un);
          if (idx >= 0) {
            results[idx] = {
              id: p.id || results[idx].id,
              username: un ? '@' + un : results[idx].username,
              name: p.name || results[idx].name,
              avatar: p.avatar || results[idx].avatar,
              verified: !!p.verified,
              status: p.status || 'offline',
            };
          }
          return;
        }
        seen.add(id); if (un) seen.add(un);
        results.push({
          id: p.id || un,
          username: un ? '@' + un : '',
          name: p.name || un,
          avatar: p.avatar || null,
          verified: !!p.verified,
          status: p.status || 'offline',
        });
      });
    } catch (e) {
      console.warn('searchProfiles failed', e);
    }
  }

  if (!results.length && query.length >= 2) {
    results.push({
      id: query.toLowerCase(),
      username: '@' + query.toLowerCase(),
      name: query,
      avatar: null,
      verified: false,
      status: 'offline',
    });
  }

  if (!results.length) {
    list.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-secondary);">Пользователь не найден</div>';
    return;
  }

  list.innerHTML = '';
  results.forEach((profile) => {
    const un = normalizePeerUsername(profile.username) || String(profile.id || '');
    const displayName = profile.name || un;
    const initials = displayName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
    const verified = profile.verified ? ' ✅' : '';
    const status = profile.status === 'online' ? '🟢 онлайн' : 'офлайн';

    const row = document.createElement('div');
    row.className = 'section-row glass r20 pressable';
    row.style.cssText = 'cursor:pointer;display:flex;align-items:center;gap:12px;padding:12px;';
    row.innerHTML = `
      ${profile.avatar
        ? `<img src="${escapeHtml(profile.avatar)}" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
        : `<div class="avatar av-g1" style="width:44px;height:44px;font-size:14px;flex-shrink:0;">${escapeHtml(initials)}</div>`}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;">@${escapeHtml(un)}${verified}</div>
        <div style="font-size:12px;color:var(--text-secondary);">${escapeHtml(displayName)} · ${status}</div>
      </div>
      <div style="font-size:20px;opacity:.5;">→</div>
    `;
    row.addEventListener('click', () => {
      startDirectChat(profile.id, un, profile);
    });
    list.appendChild(row);
  });
}

/**
 * Open a 1:1 chat with a user from search.
 * Always opens local DM immediately; also tries server conversation when IDs are available.
 */
async function startDirectChat(userId, username, profileHint) {
  try {
    const peerUser = normalizePeerUsername(username || userId);
    const peerId = String(userId || peerUser || '').trim();
    const myId = getMyProfileId();
    const myKey = getCurrentUserKey();

    if (!peerId && !peerUser) {
      showToast('Не выбран пользователь');
      return;
    }
    if (myId && peerId && String(peerId) === String(myId)) {
      showToast('Нельзя создать чат с самим собой');
      return;
    }
    if (peerUser && normalizePeerUsername(state.profile?.username) === peerUser) {
      showToast('Нельзя создать чат с самим собой');
      return;
    }

    // Cache peer for contact name/avatar in chat header
    const indexKey = peerUser || peerId;
    if (indexKey) {
      state.usersIndex = state.usersIndex || {};
      const entry = {
        ...(state.usersIndex[indexKey] || {}),
        id: peerId,
        username: peerUser ? '@' + peerUser : '',
        name: (profileHint && profileHint.name) || peerUser || peerId,
        avatar: profileHint?.avatar || null,
        verified: !!profileHint?.verified,
        status: profileHint?.status || 'offline',
      };
      state.usersIndex[indexKey] = entry;
      if (peerId && peerId !== indexKey) state.usersIndex[peerId] = entry;
    }

    // Local DM (works even without server UUID)
    const chatId = dmChatId(myKey || 'me', peerUser || peerId);
    if (!state.chats[chatId]) {
      state.chats[chatId] = {
        contactId: peerUser || peerId,
        title: (profileHint && profileHint.name) || ('@' + (peerUser || peerId)),
        handle: peerUser ? '@' + peerUser : '',
        messages: [],
        unread: 0,
        archived: false,
        pinned: false,
        lastTs: Date.now(),
        peerId: peerId || null,
      };
      try { await persistChatMeta(chatId); } catch (_) {}
    } else {
      state.chats[chatId].contactId = state.chats[chatId].contactId || peerUser || peerId;
      state.chats[chatId].title = state.chats[chatId].title || (profileHint && profileHint.name) || ('@' + (peerUser || peerId));
      state.chats[chatId].peerId = peerId || state.chats[chatId].peerId;
    }

    // Best-effort server conversation
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(peerId);
    if (myId && peerId && myId !== peerId && looksLikeUuid) {
      try {
        const conv = await createConversation('direct', [myId, peerId]);
        if (conv && conv.id) {
          state.chats[chatId].serverId = conv.id;
          if (typeof linkChatIds === 'function') linkChatIds(chatId, conv.id);
          if (!state.chats[conv.id]) {
            state.chats[conv.id] = state.chats[chatId];
          }
          try { await persistChatMeta(chatId); } catch (_) {}
        }
      } catch (e) {
        console.warn('Server createConversation failed, local chat still opened', e);
      }
    }

    openChat(chatId);
    showToast('Чат с @' + (peerUser || peerId));
  } catch (e) {
    console.error('startDirectChat', e);
    showToast('Не удалось открыть чат: ' + (e.message || 'ошибка'));
  }
}

function groupWizardNext(step) {
  if (step === 2) {
    const name = (document.getElementById('groupName')?.value || '').trim();
    if (name.length < 2) { showToast('Укажите название'); return; }
  }
  if (step === 3) {
    window.groupMembers = window.groupMembers || [];
    pendingGroupMembers = pendingGroupMembers || [];
    const elName = document.getElementById('groupConfirmName');
    const elMembers = document.getElementById('groupConfirmMembers');
    if (elName) elName.textContent = document.getElementById('groupName')?.value || '—';
    const extra = window.groupMembers.length || pendingGroupMembers.length || 0;
    if (elMembers) elMembers.textContent = String(1 + extra);
  }
  [1, 2, 3].forEach((s) => {
    const el = document.getElementById('groupStep' + s);
    if (el) el.style.display = s === step ? '' : 'none';
  });
  document.querySelectorAll('#groupWizardSteps .wiz-dot').forEach((d) => {
    const n = +d.dataset.step;
    d.classList.toggle('active', n === step);
    d.classList.toggle('done', n < step);
  });
}

async function addGroupMember() {
  window.groupMembers = window.groupMembers || [];
  const input = document.getElementById('groupUserInput');
  if (!input) return;
  const username = (input.value || '').trim().replace(/^@/, '').toLowerCase();
  if (!username || username.length < 2) {
    showToast('Введите username');
    return;
  }

  // Try server lookup for real UUID; fallback to username-only member
  let profile = null;
  try {
    if (typeof checkUsername === 'function') {
      const check = await checkUsername(username);
      if (check?.exists && check.profile) profile = check.profile;
    }
  } catch (_) {}

  if (!profile) {
    try {
      const remote = await searchProfiles(username);
      profile = (Array.isArray(remote) ? remote : []).find(
        (p) => String(p.username || '').replace(/^@/, '').toLowerCase() === username
      ) || null;
    } catch (_) {}
  }

  const id = profile?.id || username;
  if (window.groupMembers.some((m) => m.id === id || String(m.username || '').replace(/^@/, '') === username)) {
    showToast('Уже добавлен');
    return;
  }
  if (window.groupMembers.length >= 50) {
    showToast('Максимум 50 участников');
    return;
  }

  window.groupMembers.push({
    id,
    username: (profile?.username || username).replace(/^@/, ''),
  });
  // Keep legacy array in sync
  if (typeof pendingGroupMembers !== 'undefined') {
    if (!pendingGroupMembers.includes(username)) pendingGroupMembers.push(username);
  }
  input.value = '';
  renderGroupMemberChips();
}

function renderGroupMemberChips() {
  const chips = document.getElementById('groupMemberChips');
  if (!chips) return;
  window.groupMembers = window.groupMembers || [];

  if (!window.groupMembers.length && !(pendingGroupMembers && pendingGroupMembers.length)) {
    chips.innerHTML = '<span class="hint-text">Пока нет участников</span>';
    return;
  }

  if (window.groupMembers.length) {
    chips.innerHTML = window.groupMembers.map((m) => {
      const un = String(m.username || m.id || '').replace(/^@/, '');
      const safeId = String(m.id || '').replace(/'/g, '');
      return `<div style="display:inline-flex;align-items:center;background:var(--primary);color:#fff;padding:6px 12px;border-radius:16px;margin:4px;font-size:12px;">
        @${escapeHtml(un)}
        <span role="button" style="margin-left:6px;cursor:pointer;font-weight:bold;" data-mid="${escapeHtml(safeId)}">×</span>
      </div>`;
    }).join('');
    chips.querySelectorAll('[data-mid]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mid = btn.getAttribute('data-mid');
        window.groupMembers = window.groupMembers.filter((x) => String(x.id) !== String(mid));
        if (typeof pendingGroupMembers !== 'undefined') {
          pendingGroupMembers = pendingGroupMembers.filter((u) => u !== mid);
        }
        renderGroupMemberChips();
      });
    });
    return;
  }

  // Legacy username chips
  chips.innerHTML = pendingGroupMembers.map((u) =>
    `<span class="member-chip">@${escapeHtml(u)} <button type="button" onclick="removeGroupMember('${u}')" aria-label="Удалить">×</button></span>`
  ).join('');
}

function channelWizardNext(step) {
  if (step === 2) {
    const name = (document.getElementById('channelName')?.value || '').trim();
    const handle = (document.getElementById('channelHandle')?.value || '').trim().replace(/^@/, '');
    if (name.length < 2) { showToast('Укажите название'); return; }
    if (!handle || handle.length < 2) { showToast('Укажите @handle'); return; }
  }
  if (step === 3) {
    const elName = document.getElementById('channelConfirmName');
    const elHandle = document.getElementById('channelConfirmHandle');
    if (elName) elName.textContent = document.getElementById('channelName')?.value || '—';
    let h = (document.getElementById('channelHandle')?.value || '').trim();
    if (h && !h.startsWith('@')) h = '@' + h;
    if (elHandle) elHandle.textContent = h || '—';
  }
  [1, 2, 3].forEach((s) => {
    const el = document.getElementById('channelStep' + s);
    if (el) el.style.display = s === step ? '' : 'none';
  });
  ['chDot1', 'chDot2', 'chDot3'].forEach((id, i) => {
    const d = document.getElementById(id);
    if (!d) return;
    d.classList.toggle('active', i + 1 === step);
    d.classList.toggle('done', i + 1 < step);
  });
}

function previewGroupAvatar(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById('groupAvatarPreview').style.backgroundImage = `url(${e.target.result})`;
      document.getElementById('groupAvatarPreview').textContent = '';
    };
    reader.readAsDataURL(input.files[0]);
  }
}

function previewChannelAvatar(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById('channelAvatarPreview').style.backgroundImage = `url(${e.target.result})`;
      document.getElementById('channelAvatarPreview').textContent = '';
    };
    reader.readAsDataURL(input.files[0]);
  }
}

// Debounced user search (reduces API spam while typing)
const debouncedSearchUsers = (typeof ChiperCore !== 'undefined' && ChiperCore.debounce)
  ? ChiperCore.debounce(() => { try { searchUsersByUsername(); } catch (_) {} }, 320)
  : function () { try { searchUsersByUsername(); } catch (_) {} };
window.debouncedSearchUsers = debouncedSearchUsers;

// Initialize WebSocket on auth + confirm leave onboarding
const originalGo = typeof go === 'function' ? go : window.go;
window.go = function(name) {
  try {
    const current = document.body.dataset.screen || '';
    if (current === 'onboarding' && name !== 'onboarding' && window._pendingReg) {
      const nameVal = (document.getElementById('onboardName')?.value || '').trim();
      const userVal = (document.getElementById('onboardUser')?.value || '').trim();
      if ((nameVal || userVal) && !confirm('Уйти с создания профиля? Данные не сохранятся.')) {
        return;
      }
    }
  } catch (_) {}
  if (name === 'chats' && state.loggedIn && typeof connectWebSocket === 'function' && !ws) {
    connectWebSocket();
  }
  return originalGo.call(this, name);
};
if (typeof go === 'function') {
  // keep global go in sync
  // eslint-disable-next-line no-func-assign
  go = window.go;
}

// Network banner + outbox flush
function flushMessageOutbox() {
  if (typeof ChiperCore === 'undefined' || !ChiperCore.flushOutbox) return;
  ChiperCore.flushOutbox(async (item) => {
    if (item.type === 'message' && item.payload) {
      const p = item.payload;
      await postJson('/api/messages', {
        conversation_id: p.conversation_id,
        content: p.content,
        message_type: p.message_type || 'text',
        client_msg_id: p._localMsgId || undefined,
      });
      if (p._localChatId && p._localMsgId && state.chats[p._localChatId]) {
        try {
          await updateMessage(p._localChatId, p._localMsgId, { status: 'sent' });
          const m = state.chats[p._localChatId].messages?.find((x) => x.id === p._localMsgId);
          if (m) { m.status = 'sent'; updateBubbleStatus(m); }
        } catch (_) {}
      }
    } else if (item.type === 'e2ee' && item.chatId && item.msg) {
      // Re-send private E2EE message that failed earlier
      await encryptAndSendMessage(item.chatId, item.msg);
      const chatId = item.chatId;
      const msgId = item.msg.id;
      if (chatId && msgId && state.chats[chatId]) {
        try {
          await updateMessage(chatId, msgId, { status: 'sent' });
          const m = state.chats[chatId].messages?.find((x) => x.id === msgId);
          if (m) { m.status = 'sent'; updateBubbleStatus(m); }
        } catch (_) {}
      }
    } else {
      // Unknown item type — throw so it stays in the outbox instead of being dropped
      throw new Error('Unknown outbox item type: ' + (item && item.type));
    }
  }).then((r) => {
    if (r && r.sent) showToast('Отправлено из очереди: ' + r.sent);
  }).catch(() => {});
}

if (typeof ChiperCore !== 'undefined' && ChiperCore.initNetworkListeners) {
  ChiperCore.initNetworkListeners(flushMessageOutbox);
}

// Desktop / tablet detection + virtual keyboard
function updateViewportMode(){
  const w = window.innerWidth;
  document.body.classList.toggle('desktop', w >= 900);
  document.body.classList.toggle('tablet', w >= 768 && w < 900);
  document.body.classList.toggle('phone', w < 768);
  const app = document.getElementById('app');
  if (app && document.body.classList.contains('authed')) {
    if (w >= 768 && (app.classList.contains('has-chat') || document.querySelector('#screen-chats.active, #screen-chat.active'))) {
      app.classList.add('desktop-chat');
    } else if (w < 768) {
      app.classList.remove('desktop-chat');
    }
  }
  document.querySelectorAll('.bottom-nav').forEach(nav=>{
    const active = nav.querySelector('.nav-item.active');
    if(active){
      active._navInit = true;
      try { moveNavBubble(active); } catch(_){}
    }
  });
}
updateViewportMode();
window.addEventListener('resize', updateViewportMode);
window.addEventListener('orientationchange', () => setTimeout(updateViewportMode, 120));


/* Keep focus in msgInput when tapping send / mic (mousedown would blur otherwise) */
(function keepComposerFocus(){
  const bar = document.getElementById('inputBar');
  if(!bar) return;
  bar.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if(!t) return;
    // Buttons inside input-bar: prevent them from taking focus away from the text field
    if (t.closest('button') || t.closest('.round-icon') || t.closest('.send-btn') || t.closest('.icon-mic')) {
      e.preventDefault(); // keeps focus on msgInput
    }
  }, { passive: false });
})();

/* Detect mobile virtual keyboard via VisualViewport */
(function initKeyboardAware(){
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  let base = Math.max(window.innerHeight, vv.height);
  const check = () => {
    base = Math.max(base, window.innerHeight);
    const open = (base - vv.height) > 120;
    document.body.classList.toggle('keyboard-open', open);
    // Keep messages scrolled to bottom when keyboard opens (no smooth jump of input-bar)
    if (open && document.getElementById('screen-chat')?.classList.contains('active')) {
      try {
        const m = document.getElementById('messages');
        if (m) m.scrollTop = m.scrollHeight;
      } catch(_){}
    }
  };
  vv.addEventListener('resize', check);
  vv.addEventListener('scroll', check);
  window.addEventListener('focusin', (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) setTimeout(check, 50);
  });
  // Do NOT drop keyboard-open if focus is still inside chat input area
  // (e.g. user tapped send / attachment / mic — focus briefly moves then returns)
  window.addEventListener('focusout', (e) => {
    setTimeout(() => {
      const ae = document.activeElement;
      const inChatInput = ae && (
        ae.id === 'msgInput' ||
        ae.closest?.('#inputBar') ||
        ae.closest?.('#screen-chat .input-bar')
      );
      if (inChatInput) return;
      // Only remove class if keyboard actually closed
      const stillOpen = (base - vv.height) > 120;
      if (!stillOpen) document.body.classList.remove('keyboard-open');
    }, 80);
  });
})();

// Cleanup on logout
window.addEventListener('beforeunload', () => {
  if (ws) ws.close();
});
