/* ========== CHIPER DATA LAYER v3 ==========
   - Profile / settings / meta → localStorage
   - Chats metadata + messages (without heavy blobs) → IndexedDB
   - Media blobs (voice / image / file) → IndexedDB (separate store)
   - Schema versioning + migration
   - Export / Import
*/
const META_KEY = 'chiper_meta_v3';
const DB_NAME = 'chiper_db';
const DB_VERSION = 1;
const SCHEMA_VERSION = 3;

/* ========== SUPABASE (optional cloud sync) ==========
   Чтобы включить: создайте проект на https://supabase.com,
   вставьте URL и anon key ниже. Без ключей работает локально (IndexedDB).
   SQL-схема (выполнить в SQL Editor):
   create table profiles (id uuid primary key references auth.users, username text unique, name text, bio text, avatar_url text, premium boolean default false, updated_at timestamptz default now());
   create table chats (id text primary key, title text, handle text, is_group boolean, is_channel boolean, bio text, members jsonb, created_by uuid, created_at timestamptz default now());
   create table messages (id text primary key, chat_id text references chats(id), sender text, type text, text text, media_url text, ts bigint, status text);
   alter table profiles enable row level security;
   alter table chats enable row level security;
   alter table messages enable row level security;
*/

/* ========== FIREBASE ========== */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAG8nZ_ByeZWumKakczaLM2cOMMpuSVKUw",
  authDomain: "tiskgskgskggk.firebaseapp.com",
  projectId: "tiskgskgskggk",
  storageBucket: "tiskgskgskggk.firebasestorage.app",
  messagingSenderId: "250321205902",
  appId: "1:250321205902:web:d333bb6be2f61af8e4e7df",
  measurementId: "G-9D8NHGYLRR"
};
let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;
let firebaseStorage = null;
let firebaseAnalytics = null;

function initFirebase(){
  try{
    if(typeof firebase === 'undefined'){
      console.warn('Firebase SDK not loaded');
      return null;
    }
    if(!firebase.apps.length){
      firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
    } else {
      firebaseApp = firebase.app();
    }
    firebaseAuth = firebase.auth();
    // settings MUST be before any Firestore use
    try{
      firebase.firestore().settings({
        ignoreUndefinedProperties: true,
        // helps on mobile networks / flaky websockets
        experimentalAutoDetectLongPolling: true,
      });
    }catch(_){ /* settings already applied */ }
    firebaseDb = firebase.firestore();
    try{ firebaseDb.enableNetwork(); }catch(_){}
    try{ firebaseStorage = firebase.storage(); }catch(_){}
    try{
      if(firebase.analytics) firebaseAnalytics = firebase.analytics();
    }catch(_){}
    console.log('Firebase ready');
    return firebaseApp;
  }catch(e){
    console.error('Firebase init failed', e);
    return null;
  }
}

/** Force Firestore online and wait briefly for connection */
async function ensureFirestoreOnline(){
  if(!firebaseDb) initFirebase();
  if(!firebaseDb) return false;
  try{ await firebaseDb.enableNetwork(); }catch(_){}
  // small wait so client can leave "offline" state
  await new Promise(r => setTimeout(r, 300));
  return true;
}

async function firebaseSignInEmail(email, password){
  if(!firebaseAuth) initFirebase();
  if(!firebaseAuth) throw new Error('Firebase Auth unavailable');
  const cred = await firebaseAuth.signInWithEmailAndPassword(email, password);
  return cred.user;
}

async function firebaseRegisterEmail(email, password){
  if(!firebaseAuth) initFirebase();
  if(!firebaseAuth) throw new Error('Firebase Auth unavailable');
  const cred = await firebaseAuth.createUserWithEmailAndPassword(email, password);
  return cred.user;
}

async function syncProfileToFirestore(){
  if(!firebaseDb || !firebaseAuth?.currentUser) return;
  const uid = firebaseAuth.currentUser.uid;
  const p = state.profile || {};
  const data = {
    uid,
    username: p.username || '',
    name: p.name || '',
    bio: p.bio || '',
    avatarUrl: (p.avatar && String(p.avatar).startsWith('http')) ? p.avatar : null,
    bannerUrl: (p.banner && String(p.banner).startsWith('http')) ? p.banner : null,
    avatarPosition: p.avatarPosition || 'center',
    city: p.city || null,
    birthday: p.birthday || null,
    gender: p.gender || null,
    website: p.website || null,
    phone: p.phone || null,
    premium: !!p.premium,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  await firebaseDb.collection('profiles').doc(uid).set(data, { merge: true });
  if(p.username){
    const handle = String(p.username).replace(/^@/,'').toLowerCase();
    await firebaseDb.collection('usernames').doc(handle).set({
      uid, username: p.username, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
}

async function loadProfileFromFirestore(uid){
  if(!firebaseDb) return null;
  const snap = await firebaseDb.collection('profiles').doc(uid).get();
  return snap.exists ? snap.data() : null;
}


/* ========== FIRESTORE DATA LAYER (no local DB) ========== */
function fs(){
  if(!firebaseDb) initFirebase();
  return firebaseDb;
}

async function fsGetUser(uid){
  if(!fs() || !uid) return null;
  const snap = await firebaseDb.collection('users').doc(uid).get();
  return snap.exists ? snap.data() : null;
}

function stripHeavyProfileFields(profile){
  // Firestore doc limit 1MB — never write base64 data: URLs to cloud
  const data = { ...profile };
  const isHeavy = (v) => typeof v === 'string' && (v.startsWith('data:') || v.length > 2000);
  if(isHeavy(data.avatar)) data.avatar = null;
  if(isHeavy(data.banner)) data.banner = null;
  if(Array.isArray(data.avatars)){
    data.avatars = data.avatars
      .filter(a => a && a.data && !String(a.data).startsWith('data:') && String(a.data).length < 2000)
      .map(a => ({ id: a.id, data: a.data, type: a.type || 'image' }))
      .slice(0, 5);
  } else {
    data.avatars = [];
  }
  delete data._localOnly;
  return data;
}

/** Build a payload that matches Firestore rules for users/{uid} create/update */
function buildCloudUserPayload(uid, profile){
  let username = normalizeUsername(profile.username || '');
  const name = String(profile.name || '').trim().slice(0, 64);
  // Rules: validUsername — @?[a-zA-Z0-9._]{2,32}, size 3–33
  if(!/^@[a-z0-9._]{2,32}$/i.test(username)){
    throw new Error('Некорректный username для облака');
  }
  username = username.toLowerCase();
  const data = {
    uid: String(uid),
    email: (profile.email || '').toLowerCase() || null,
    name,
    username,
    bio: String(profile.bio || '').slice(0, 500),
    avatar: (profile.avatar && String(profile.avatar).startsWith('http')) ? profile.avatar : null,
    avatarType: profile.avatarType || 'image',
    avatarPosition: profile.avatarPosition || profile.avatarPos || 'center',
    // Protected by rules — must stay at defaults on create / unchanged on update
    isAdmin: false,
    coins: 0,
    stars: 0,
    verified: false,
    premium: false,
    premiumUntil: 0,
    createdAt: profile.createdAt || Date.now(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  // Only include http avatars in cloud array
  if(Array.isArray(profile.avatars)){
    data.avatars = profile.avatars
      .filter(a => a && a.data && String(a.data).startsWith('http'))
      .map(a => ({ id: a.id, data: a.data, type: a.type || 'image' }))
      .slice(0, 5);
  }
  return data;
}

async function fsSaveUser(uid, profile){
  if(!fs() || !uid) throw new Error('Firestore не инициализирован');
  if(!firebaseAuth?.currentUser) throw new Error('Нет авторизации Firebase');
  if(firebaseAuth.currentUser.uid !== uid) throw new Error('uid не совпадает с сессией');

  await ensureFirestoreOnline();

  const data = buildCloudUserPayload(uid, profile);

  // Try to preserve protected fields (coins/premium/…) without blocking if offline
  try{
    const existing = await firebaseDb.collection('users').doc(uid).get({ source: 'cache' });
    if(existing && existing.exists){
      const old = existing.data() || {};
      data.isAdmin = old.isAdmin === true;
      data.coins = typeof old.coins === 'number' ? old.coins : 0;
      data.stars = typeof old.stars === 'number' ? old.stars : 0;
      data.verified = old.verified === true;
      data.premium = old.premium === true;
      data.premiumUntil = typeof old.premiumUntil === 'number' ? old.premiumUntil : 0;
      if(old.createdAt) data.createdAt = old.createdAt;
    }
  }catch(_){ /* first create or empty cache — defaults are fine */ }

  async function writeOnce(){
    await firebaseDb.collection('users').doc(uid).set(data, { merge: true });
    const handle = data.username.replace(/^@/, '').toLowerCase();
    if(handle){
      try{
        await firebaseDb.collection('usernames').doc(handle).set({
          uid: uid,
          username: data.username,
          email: data.email,
          name: data.name,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }catch(e){
        console.warn('usernames index write failed', e.code || e.message);
      }
    }
  }

  try{
    await writeOnce();
  }catch(e){
    // Offline / transient → enable network and retry once
    const msg = (e && (e.message || e.code)) || '';
    if(/offline|unavailable|network/i.test(String(msg))){
      await ensureFirestoreOnline();
      await new Promise(r => setTimeout(r, 800));
      await writeOnce();
    } else {
      throw e;
    }
  }
  return true;
}

async function fsSaveSettings(uid, settings){
  if(!fs() || !uid) return;
  await firebaseDb.collection('users').doc(uid).set({ settings: settings || {} }, { merge: true });
}

async function fsIsUsernameTaken(username, exceptUid){
  const handle = String(username).replace(/^@/,'').toLowerCase();
  if(!handle || !fs()) return false;
  try{
    await ensureFirestoreOnline();
    const snap = await Promise.race([
      firebaseDb.collection('usernames').doc(handle).get({ source: 'server' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
    ]);
    if(!snap || !snap.exists) return false;
    const d = snap.data() || {};
    return d.uid && d.uid !== exceptUid;
  }catch(e){
    console.warn('fsIsUsernameTaken', e.message || e);
    return false; // offline → don't block signup
  }
}

async function fsUploadDataUrl(dataUrl, path){
  if(!firebaseStorage) throw new Error('Storage unavailable');
  const ref = firebaseStorage.ref().child(path);
  if(String(dataUrl).startsWith('data:')){
    await ref.putString(dataUrl, 'data_url');
  } else {
    // remote URL — just return
    return dataUrl;
  }
  return await ref.getDownloadURL();
}

async function fsUploadBlob(blob, path){
  if(!firebaseStorage) throw new Error('Storage unavailable');
  const ref = firebaseStorage.ref().child(path);
  await ref.put(blob);
  return await ref.getDownloadURL();
}

async function onFirebaseUser(user, preloaded){
  if(!user) return;
  let profile = preloaded || await fsGetUser(user.uid);
  if(!profile || !profile.username){
    // Firebase account exists but Chiper profile not finished — force onboarding
    state.loggedIn = false;
    document.body.classList.remove('authed');
    window._pendingReg = {
      email: (user.email || '').toLowerCase(),
      uid: user.uid,
      viaGoogle: !!(user.providerData || []).some(p => p.providerId === 'google.com'),
      photoURL: user.photoURL || null,
      displayName: user.displayName || ''
    };
    const local = (user.email || 'user').split('@')[0].replace(/[^a-z0-9._]/gi,'').slice(0,20) || 'user';
    const ou = document.getElementById('onboardUser');
    if(ou) ou.value = '@' + local;
    const on = document.getElementById('onboardName');
    if(on) on.value = user.displayName || (local.charAt(0).toUpperCase() + local.slice(1));
    if(user.photoURL){
      window._onboardAvatarData = user.photoURL;
      const av = document.getElementById('onboardAvatar');
      if(av){ av.style.backgroundImage = `url(${user.photoURL})`; av.textContent = ''; }
    }
    go('onboarding');
    return;
  }
  state.profile = {
    ...profile,
    uid: user.uid,
    email: profile.email || user.email || ''
  };
  if(profile.settings) state.settings = { ...state.settings, ...profile.settings };
  state.loggedIn = true;
  document.body.classList.add('authed');
  await loadChatsFromFirestore();
  go('chats');
  renderChatList();
  renderProfile();
  try{ updateCoinsUI(); }catch(_){}
  try{ subscribeFirestore(); }catch(_){}
}

async function loadChatsFromFirestore(){
  state.chats = {};
  if(!fs() || !state.profile?.uid) return;
  const uid = state.profile.uid;
  // membership index
  const mem = await firebaseDb.collection('userChats').doc(uid).collection('items').get();
  const ids = [];
  mem.forEach(doc => ids.push(doc.id));
  // also chats where members array contains me (legacy)
  if(!ids.length){
    const q = await firebaseDb.collection('chats').where('memberUids', 'array-contains', uid).limit(100).get();
    q.forEach(doc => ids.push(doc.id));
  }
  for(const id of ids){
    const cSnap = await firebaseDb.collection('chats').doc(id).get();
    if(!cSnap.exists) continue;
    const c = cSnap.data();
    const mSnap = await firebaseDb.collection('chats').doc(id).collection('messages')
      .orderBy('ts', 'asc').limit(300).get();
    const messages = [];
    mSnap.forEach(d => messages.push({ id: d.id, ...d.data() }));
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
    };
  }
}

async function persistChatMeta(chatId){
  const chat = state.chats[chatId];
  if(!chat || !fs()) return;
  const uid = state.profile?.uid;
  const payload = {
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
    bio: chat.bio || null,
    members: chat.members || [],
    memberUids: chat.memberUids || (uid ? [uid] : []),
    avatar: (chat.avatar && String(chat.avatar).length < 200000) ? chat.avatar : (chat.avatarUrl || null),
    subscribed: chat.subscribed !== false,
    joined: chat.joined !== false,
    subscribers: chat.subscribers || null,
    isPublic: chat.isPublic !== false,
    createdBy: chat.createdBy || null,
    admins: chat.admins || [],
    pinnedMsgId: chat.pinnedMsgId || null,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  await firebaseDb.collection('chats').doc(chatId).set(payload, { merge: true });
  if(uid){
    await firebaseDb.collection('userChats').doc(uid).collection('items').doc(chatId).set({
      chatId, lastTs: payload.lastTs, archived: payload.archived, pinned: payload.pinned, unread: payload.unread
    }, { merge: true });
  }
}

async function persistMessage(chatId, msg){
  if(!fs()) return;
  const toStore = { ...msg };
  // Upload media to Storage instead of storing base64 in Firestore
  if(msg.data && (msg.type === 'voice' || msg.type === 'image' || msg.type === 'file')){
    try{
      const path = 'media/' + chatId + '/' + (msg.id || Date.now()) + (msg.type==='voice'?'.webm': msg.type==='image'?'.jpg':'.bin');
      if(String(msg.data).startsWith('data:')){
        toStore.mediaUrl = await fsUploadDataUrl(msg.data, path);
      } else {
        toStore.mediaUrl = msg.data;
      }
      delete toStore.data;
    }catch(e){
      console.warn('media upload failed', e);
      // fallback: drop heavy data to avoid 1MB limit
      delete toStore.data;
    }
  }
  delete toStore.waveform; // optional large field
  toStore.chatId = chatId;
  await firebaseDb.collection('chats').doc(chatId).collection('messages').doc(msg.id).set(toStore, { merge: true });
  await firebaseDb.collection('chats').doc(chatId).set({ lastTs: msg.ts || Date.now() }, { merge: true });
  const chat = state.chats[chatId];
  if(chat){
    chat.lastTs = msg.ts || Date.now();
    await persistChatMeta(chatId);
  }
  // also keep mediaUrl on in-memory msg for playback
  if(toStore.mediaUrl) msg.data = toStore.mediaUrl;
}

async function deleteMessageFromDB(msgId){
  const chatId = state.currentChatId;
  if(!chatId || !fs()) return;
  await firebaseDb.collection('chats').doc(chatId).collection('messages').doc(msgId).delete();
}

async function updateMessage(chatId, msgId, patch){
  const chat = state.chats[chatId];
  const m = chat?.messages.find(x => x.id === msgId);
  if(m) Object.assign(m, patch);
  if(fs()){
    await firebaseDb.collection('chats').doc(chatId).collection('messages').doc(msgId).set(patch, { merge: true });
  }
  if(bc) bc.postMessage({ type: 'update_message', chatId, msgId, patch });
}

async function removeMessage(chatId, msgId){
  const chat = state.chats[chatId];
  if(chat) chat.messages = chat.messages.filter(m => m.id !== msgId);
  await deleteMessageFromDB(msgId);
  if(bc) bc.postMessage({ type: 'delete_message', chatId, msgId });
}

// Override local saveMeta/loadMeta to Firestore settings only (no localStorage)
function saveMeta(){
  try{
    const uid = state.profile?.uid || firebaseAuth?.currentUser?.uid;
    if(uid && firebaseDb){
      const payload = {
        settings: state.settings || {},
        // keep profile light fields in sync
        name: state.profile?.name,
        username: state.profile?.username,
        bio: state.profile?.bio,
        avatar: state.profile?.avatar,
        avatarType: state.profile?.avatarType,
        avatars: state.profile?.avatars,
        coins: state.profile?.coins,
        stars: state.profile?.stars,
        verified: state.profile?.verified,
        premium: state.profile?.premium,
        premiumUntil: state.profile?.premiumUntil,
        isAdmin: state.profile?.isAdmin,
        avatarPosition: state.profile?.avatarPosition || state.profile?.avatarPos,
        customStatus: state.profile?.customStatus,
        badge: state.profile?.badge,
        email: state.profile?.email,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      firebaseDb.collection('users').doc(uid).set(payload, { merge: true }).catch(e => console.warn('saveMeta', e));
    }
  }catch(e){ console.warn(e); }
}

function loadMeta(){
  // no localStorage — return schema version only for compatibility
  return SCHEMA_VERSION;
}

function loadAccounts(){ return {}; }
function saveAccounts(){ /* no-op: Firestore only */ }

async function persistProfileToAccounts(){
  const uid = state.profile?.uid || firebaseAuth?.currentUser?.uid;
  if(!uid) return;
  await fsSaveUser(uid, state.profile);
}

let _unsubMsgs = {};
let _unsubChats = null;
function subscribeFirestore(){
  if(!fs() || !state.profile?.uid) return;
  const uid = state.profile.uid;
  if(_unsubChats) try{ _unsubChats(); }catch(_){}
  _unsubChats = firebaseDb.collection('userChats').doc(uid).collection('items')
    .onSnapshot(async (snap) => {
      for(const change of snap.docChanges()){
        const id = change.doc.id;
        if(change.type === 'removed'){
          delete state.chats[id];
          renderChatList();
          continue;
        }
        // refresh chat meta + latest messages if unknown
        if(!state.chats[id]){
          await loadOneChat(id);
          renderChatList();
        }
      }
    }, err => console.warn('userChats listen', err));
}

async function loadOneChat(id){
  if(!fs()) return;
  const cSnap = await firebaseDb.collection('chats').doc(id).get();
  if(!cSnap.exists) return;
  const c = cSnap.data();
  const mSnap = await firebaseDb.collection('chats').doc(id).collection('messages').orderBy('ts','asc').limit(300).get();
  const messages = [];
  mSnap.forEach(d => {
    const m = { id: d.id, ...d.data() };
    if(m.mediaUrl && !m.data) m.data = m.mediaUrl;
    messages.push(m);
  });
  state.chats[id] = {
    contactId: c.contactId || id,
    messages,
    unread: c.unread || 0,
    archived: !!c.archived,
    pinned: !!c.pinned,
    muted: !!c.muted,
    lastTs: c.lastTs || 0,
    title: c.title || null,
    handle: c.handle || null,
    isGroup: !!c.isGroup,
    isChannel: !!c.isChannel,
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
  };
  // live messages
  if(_unsubMsgs[id]) try{ _unsubMsgs[id](); }catch(_){}
  _unsubMsgs[id] = firebaseDb.collection('chats').doc(id).collection('messages').orderBy('ts','asc')
    .onSnapshot(snap => {
      const chat = state.chats[id];
      if(!chat) return;
      snap.docChanges().forEach(ch => {
        if(ch.type === 'added'){
          const m = { id: ch.doc.id, ...ch.doc.data() };
          if(m.mediaUrl && !m.data) m.data = m.mediaUrl;
          if(!chat.messages.some(x => x.id === m.id)){
            chat.messages.push(m);
            if(state.currentChatId === id){
              const el = createBubbleEl(m);
              document.getElementById('messages')?.appendChild(el);
              requestAnimationFrame(()=> el.classList.add('show'));
              scrollMessagesToBottom();
            } else if(!isMessageOut(m)){
              chat.unread = (chat.unread||0)+1;
              if(!chat.muted) notifyNewMessage(id, m);
            }
          }
        }
      });
      renderChatList();
    });
}


function setAvatarPosition(pos){
  const allowed = ['left','center','right'];
  if(!allowed.includes(pos)) pos = 'center';
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
  try{ syncProfileToFirestore(); }catch(_){}
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


const SUPABASE_URL = ''; // например 'https://xxxx.supabase.co'
const SUPABASE_ANON_KEY = '';
let supabaseClient = null;
async function initSupabase(){
  if(!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try{
    if(!window.supabase){
      await new Promise((resolve, reject)=>{
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('[Chiper] Supabase connected');
    return supabaseClient;
  }catch(e){
    console.warn('[Chiper] Supabase init failed, using local DB', e);
    return null;
  }
}
async function supabaseSyncProfile(){
  if(!supabaseClient || !state.profile?.email) return;
  try{
    await supabaseClient.from('profiles').upsert({
      username: state.profile.username,
      name: state.profile.name,
      bio: state.profile.bio,
      premium: !!state.profile.premium,
      updated_at: new Date().toISOString(),
    });
  }catch(e){ console.warn('supabase profile sync', e); }
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
    accent: 'purple',
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
  // IndexedDB disabled — Firestore only
  return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if(!database.objectStoreNames.contains('chats')){
        const chats = database.createObjectStore('chats', { keyPath: 'id' });
        chats.createIndex('lastTs', 'lastTs');
        chats.createIndex('archived', 'archived');
      }
      if(!database.objectStoreNames.contains('messages')){
        const msgs = database.createObjectStore('messages', { keyPath: 'id' });
        msgs.createIndex('chatId', 'chatId');
        msgs.createIndex('ts', 'ts');
      }
      if(!database.objectStoreNames.contains('media')){
        database.createObjectStore('media', { keyPath: 'id' });
      }
      if(!database.objectStoreNames.contains('meta')){
        database.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
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
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(store, indexName, query){
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const req = indexName ? os.index(indexName).getAll(query) : os.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, value){
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(store, key){
  return new Promise((resolve, reject) => {
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

/* ---------- Meta (Firestore only — localStorage removed) ---------- */
function loadMeta(){
  return SCHEMA_VERSION;
}
function saveMeta(){
  try{
    const uid = state.profile?.uid || firebaseAuth?.currentUser?.uid;
    if(uid && firebaseDb){
      firebaseDb.collection('users').doc(uid).set({
        settings: state.settings || {},
        name: state.profile?.name,
        username: state.profile?.username,
        bio: state.profile?.bio,
        avatar: state.profile?.avatar,
        avatarType: state.profile?.avatarType,
        avatars: state.profile?.avatars,
        coins: state.profile?.coins,
        stars: state.profile?.stars,
        verified: state.profile?.verified,
        premium: state.profile?.premium,
        premiumUntil: state.profile?.premiumUntil,
        isAdmin: state.profile?.isAdmin,
        avatarPosition: state.profile?.avatarPosition,
        email: state.profile?.email,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(e => console.warn('saveMeta', e));
    }
  }catch(e){ console.warn(e); }
}

async function loadAllChats(){
  await loadChatsFromFirestore();
}


async function persistChatMeta(chatId){
  // delegated — implemented in Firestore layer above; keep single definition
  const chat = state.chats[chatId];
  if(!chat || !firebaseDb) return;
  const uid = state.profile?.uid;
  const payload = {
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
    bio: chat.bio || null,
    members: chat.members || [],
    memberUids: chat.memberUids || (uid ? [uid] : []),
    avatar: (chat.avatar && String(chat.avatar).length < 200000) ? chat.avatar : null,
    subscribed: chat.subscribed !== false,
    joined: chat.joined !== false,
    subscribers: chat.subscribers || null,
    isPublic: chat.isPublic !== false,
    createdBy: chat.createdBy || null,
    admins: chat.admins || [],
    pinnedMsgId: chat.pinnedMsgId || null,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  await firebaseDb.collection('chats').doc(chatId).set(payload, { merge: true });
  if(uid){
    await firebaseDb.collection('userChats').doc(uid).collection('items').doc(chatId).set({
      chatId, lastTs: payload.lastTs, archived: payload.archived, pinned: payload.pinned, unread: payload.unread
    }, { merge: true });
  }
}


async function persistMessage(chatId, msg){
  if(!firebaseDb) return;
  const toStore = { ...msg };
  if(msg.data && (msg.type === 'voice' || msg.type === 'image' || msg.type === 'file')){
    try{
      const path = 'media/' + chatId + '/' + (msg.id || Date.now()) + (msg.type==='voice'?'.webm': msg.type==='image'?'.jpg':'.bin');
      if(String(msg.data).startsWith('data:') && firebaseStorage){
        toStore.mediaUrl = await fsUploadDataUrl(msg.data, path);
      } else {
        toStore.mediaUrl = msg.data;
      }
      delete toStore.data;
    }catch(e){
      console.warn('media upload', e);
      delete toStore.data;
    }
  }
  delete toStore.waveform;
  toStore.chatId = chatId;
  await firebaseDb.collection('chats').doc(chatId).collection('messages').doc(msg.id).set(toStore, { merge: true });
  await firebaseDb.collection('chats').doc(chatId).set({ lastTs: msg.ts || Date.now() }, { merge: true });
  if(toStore.mediaUrl) msg.data = toStore.mediaUrl;
  if(state.chats[chatId]) {
    state.chats[chatId].lastTs = msg.ts || Date.now();
    await persistChatMeta(chatId);
  }
}


async function deleteMessageFromDB(msgId){
  const msg = await idbGet('messages', msgId);
  if(msg?.mediaId) await idbDelete('media', msg.mediaId);
  await idbDelete('messages', msgId);
}

async function saveState(){
  // meta always
  saveMeta();
  // all chat metas + current messages are persisted on mutation
  // for safety we can flush current chat
  if(state.currentChatId && state.chats[state.currentChatId]){
    await persistChatMeta(state.currentChatId);
  }
}

/* ---------- Migration from v2 (localStorage) ---------- */
async function migrateFromV2(){
  // local migration disabled — data lives in Firestore / IndexedDB
  return false;
}

/* ---------- Public API used by UI ---------- */
async function loadState(){
  // Firestore-only: wait for Firebase Auth session
  initFirebase();
  applyTheme();
  applyAccent();
  applyCompact();
  applyThemeSchedule();
  try{ registerPWA(); }catch(_){}
  if(state.settings.notifications) ensureNotifPermission().catch(()=>{});
  if(!firebaseAuth){
    console.warn('No Firebase Auth');
    return;
  }
  // Always start logged-out in UI; Auth will promote if session exists
  state.loggedIn = false;
  document.body.classList.remove('authed');
  try{ go('login'); }catch(_){}

  // Complete Google redirect sign-in if returning from redirect
  try{
    const redir = await firebaseAuth.getRedirectResult();
    if(redir && redir.user){
      await onFirebaseUser(redir.user);
      return;
    }
  }catch(e){
    console.warn('getRedirectResult', e);
  }

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if(!done){ done = true; resolve(); } };
    const unsub = firebaseAuth.onAuthStateChanged(async (user) => {
      try{
        if(user){
          await onFirebaseUser(user);
        } else {
          state.loggedIn = false;
          state.profile = { name: '', username: '', uid: null };
          state.chats = {};
          document.body.classList.remove('authed');
          window._pendingReg = null;
          go('login');
        }
      }catch(e){
        console.error(e);
        state.loggedIn = false;
        document.body.classList.remove('authed');
        go('login');
      }
      try{ unsub(); }catch(_){}
      finish();
    });
    // safety timeout so UI never hangs on login
    setTimeout(finish, 4000);
  });
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
  if(firebaseDb){
    await firebaseDb.collection('chats').doc(chatId).collection('messages').doc(msgId).set(patch, { merge: true });
  }
  if(bc) bc.postMessage({ type: 'update_message', chatId, msgId, patch });
}

async function removeMessage(chatId, msgId){
  const chat = state.chats[chatId];
  if(chat) chat.messages = chat.messages.filter(m => m.id !== msgId);
  if(firebaseDb){
    await firebaseDb.collection('chats').doc(chatId).collection('messages').doc(msgId).delete();
  }
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
  // clear in-memory; write into Firestore on persist
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


