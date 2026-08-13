/* ========== AUTH ========== */
/* ========== AUTH (email / Gmail) ========== */
const ACCOUNTS_KEY = 'chiper_accounts_v1';

function loadAccounts(){ return {}; }
function saveAccounts(acc){ /* firestore only */ }


function saveAccounts(acc){
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(acc));
}
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
  // lightweight demo hash (not production-grade)
  let h = 0;
  for(let i=0;i<p.length;i++){ h = ((h<<5)-h) + p.charCodeAt(i); h |= 0; }
  return 'h' + (h >>> 0).toString(16);
}

function normalizeUsername(u){
  let s = String(u || '').trim().toLowerCase();
  if(!s.startsWith('@')) s = '@' + s;
  return s;
}

/** Returns true if username is already taken by another account (or current if excludeEmail not matching). */
async function isUsernameTaken(username, excludeUid){
  const un = normalizeUsername(username);
  if(un.length < 3) return true;
  const uid = excludeUid || state.profile?.uid || firebaseAuth?.currentUser?.uid;
  return await fsIsUsernameTaken(un, uid);
}

function getCurrentUserKey(){
  return normalizeUsername(state.profile?.username || '');
}

function isMessageOut(m){
  if(m.from){
    return normalizeUsername(m.from) === getCurrentUserKey();
  }
  // legacy fallback
  return !!m.out;
}

/** Canonical DM id so both accounts share the same chat store */
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

async function doLogin(){
  try{
    showAuthError('loginError', '');
    const email = (document.getElementById('loginUser')?.value || '').trim().toLowerCase();
    const pass = document.getElementById('loginPass')?.value || '';
    if(!isValidEmail(email)){ showAuthError('loginError', 'Введите корректный email'); return; }
    if(pass.length < 6){ showAuthError('loginError', 'Пароль слишком короткий'); return; }
    const btn = document.getElementById('loginBtn');
    if(btn){ btn.disabled = true; btn.textContent = 'Вход…'; }
    if(!firebaseAuth) initFirebase();
    if(!firebaseAuth){ showAuthError('loginError', 'Firebase недоступен'); return; }
    const cred = await firebaseAuth.signInWithEmailAndPassword(email, pass);
    await onFirebaseUser(cred.user);
    showToast('С возвращением!');
  }catch(e){
    console.error(e);
    const code = e.code || '';
    let msg = 'Ошибка входа';
    if(code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential') msg = 'Неверный email или пароль';
    else if(code === 'auth/too-many-requests') msg = 'Слишком много попыток';
    else if(e.message) msg = e.message;
    showAuthError('loginError', msg);
  }finally{
    const btn = document.getElementById('loginBtn');
    if(btn){ btn.disabled = false; btn.textContent = 'Войти'; }
  }
}

async function doRegister(){
  try{
    showAuthError('regError', '');
    const email = (document.getElementById('regEmail')?.value || '').trim().toLowerCase();
    const pass = document.getElementById('regPass')?.value || '';
    if(!isValidEmail(email)){ showAuthError('regError', 'Введите корректный email (например Gmail)'); return; }
    if(pass.length < 6){ showAuthError('regError', 'Пароль минимум 6 символов'); return; }
    const btn = document.getElementById('regBtn');
    if(btn){ btn.disabled = true; btn.textContent = 'Создание…'; }
    if(!firebaseAuth) initFirebase();
    if(!firebaseAuth){ showAuthError('regError', 'Firebase недоступен'); return; }
    // Create Firebase Auth account now; profile completed in onboarding
    let user;
    try{
      const cred = await firebaseAuth.createUserWithEmailAndPassword(email, pass);
      user = cred.user;
    }catch(err){
      if(err.code === 'auth/email-already-in-use'){
        showAuthError('regError', 'Этот email уже зарегистрирован');
        return;
      }
      throw err;
    }
    window._pendingReg = { email, uid: user.uid, viaGoogle: false };
    const local = email.split('@')[0].replace(/[^a-z0-9._]/gi,'').slice(0,20) || 'user';
    document.getElementById('onboardUser').value = '@' + local;
    document.getElementById('onboardName').value = local.charAt(0).toUpperCase() + local.slice(1);
    document.getElementById('onboardBio').value = '';
    document.getElementById('onboardAvatar').textContent = local.slice(0,2).toUpperCase();
    document.getElementById('onboardAvatar').style.backgroundImage = '';
    go('onboarding');
  }catch(e){
    console.error(e);
    showAuthError('regError', e.message || 'Ошибка регистрации');
  }finally{
    const btn = document.getElementById('regBtn');
    if(btn){ btn.disabled = false; btn.textContent = 'Далее'; }
  }
}

async function authWithGoogle(mode){
  try{
    if(!firebaseAuth) initFirebase();
    if(!firebaseAuth){ showToast('Firebase недоступен'); return; }
    showToast('Открываем Google…');
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.addScope('email');
    provider.addScope('profile');
    provider.setCustomParameters({ prompt: 'select_account' });

    let user = null;
    try{
      // Popup first
      const result = await firebaseAuth.signInWithPopup(provider);
      user = result.user;
    }catch(popErr){
      // Mobile / blocked popup → redirect
      if(popErr.code === 'auth/popup-blocked' ||
         popErr.code === 'auth/cancelled-popup-request' ||
         /popup/i.test(popErr.message || '')){
        try{
          await firebaseAuth.signInWithRedirect(provider);
          return; // page will reload; onAuthStateChanged handles the rest
        }catch(redirErr){
          throw redirErr;
        }
      }
      throw popErr;
    }

    if(!user){ showToast('Вход отменён'); return; }

    let existing = null;
    try{
      existing = await Promise.race([
        fsGetUser(user.uid),
        new Promise((res) => setTimeout(() => res(null), 5000))
      ]);
    }catch(_){ existing = null; }

    if(existing && existing.username){
      await onFirebaseUser(user, existing);
      showToast('Вход через Google');
      return;
    }

    // New Google user → onboarding
    window._pendingReg = {
      email: (user.email || '').toLowerCase(),
      uid: user.uid,
      viaGoogle: true,
      photoURL: user.photoURL || null,
      displayName: user.displayName || ''
    };
    const local = (user.email || 'user').split('@')[0].replace(/[^a-z0-9._]/gi,'').slice(0,20) || 'user';
    const ou = document.getElementById('onboardUser');
    const on = document.getElementById('onboardName');
    const ob = document.getElementById('onboardBio');
    if(ou) ou.value = '@' + local;
    if(on) on.value = user.displayName || (local.charAt(0).toUpperCase() + local.slice(1));
    if(ob) ob.value = '';
    if(user.photoURL){
      window._onboardAvatarData = user.photoURL;
      const av = document.getElementById('onboardAvatar');
      if(av){ av.style.backgroundImage = `url(${user.photoURL})`; av.textContent = ''; }
    } else {
      const av = document.getElementById('onboardAvatar');
      if(av){ av.textContent = local.slice(0,2).toUpperCase(); av.style.backgroundImage = ''; }
    }
    go('onboarding');
    showToast('Создайте профиль');
  }catch(e){
    console.error(e);
    if(e.code === 'auth/popup-closed-by-user') showToast('Окно закрыто');
    else if(e.code === 'auth/unauthorized-domain') showToast('Добавьте домен в Firebase → Authentication → Settings → Authorized domains');
    else if(e.code === 'auth/operation-not-allowed') showToast('Включите Google в Firebase Authentication');
    else showToast(e.message || 'Ошибка Google входа');
  }
}

function handleOnboardAvatar(input){
  const file = input.files?.[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    window._onboardAvatarData = ev.target.result;
    const av = document.getElementById('onboardAvatar');
    av.style.backgroundImage = `url(${ev.target.result})`;
    av.textContent = '';
  };
  reader.readAsDataURL(file);
}

async function finishOnboarding(){
  const btn = document.getElementById('onboardDoneBtn');
  try{
    showAuthError('onboardError', '');
    if(btn){ btn.disabled = true; btn.textContent = 'Сохранение…'; }

    // Recover pending reg from Firebase session if page was reloaded
    if(!window._pendingReg){
      if(!firebaseAuth) initFirebase();
      const u = firebaseAuth?.currentUser;
      if(u){
        window._pendingReg = {
          email: (u.email || '').toLowerCase(),
          uid: u.uid,
          viaGoogle: !!(u.providerData || []).some(p => p.providerId === 'google.com'),
          photoURL: u.photoURL || null,
          displayName: u.displayName || ''
        };
      }
    }
    const pending = window._pendingReg;
    if(!pending){
      showAuthError('onboardError', 'Сессия не найдена — зарегистрируйтесь снова');
      go('register');
      return;
    }

    const name = (document.getElementById('onboardName')?.value || '').trim();
    let username = (document.getElementById('onboardUser')?.value || '').trim();
    const bio = (document.getElementById('onboardBio')?.value || '').trim();
    if(name.length < 2){ showAuthError('onboardError', 'Укажите имя'); return; }
    if(!username.startsWith('@')) username = '@' + username;
    username = normalizeUsername(username);
    if(username.length < 3 || !/^@[a-z0-9._]{2,31}$/i.test(username)){
      showAuthError('onboardError', 'Некорректный @username (латиница, 2–31 символ)');
      return;
    }

    if(!firebaseAuth) initFirebase();
    const user = firebaseAuth?.currentUser;
    if(!user){
      showAuthError('onboardError', 'Сессия потеряна — войдите снова');
      go('login');
      return;
    }

    // Bring Firestore online before any cloud ops
    await ensureFirestoreOnline();

    // Username uniqueness (skip if offline / slow — don't block registration)
    try{
      const taken = await Promise.race([
        fsIsUsernameTaken(username, user.uid),
        new Promise((resolve) => setTimeout(() => resolve(false), 2500))
      ]);
      if(taken){ showAuthError('onboardError', 'Этот @username уже занят'); return; }
    }catch(e){
      console.warn('username check skipped', e);
    }

    let avatar = window._onboardAvatarData || pending.photoURL || null;
    if(avatar && String(avatar).startsWith('data:') && firebaseStorage){
      try{ avatar = await fsUploadDataUrl(avatar, 'avatars/' + user.uid + '/main.jpg'); }
      catch(e){ console.warn('avatar upload', e); /* keep data URL locally */ }
    }

    const profile = {
      uid: user.uid,
      email: (pending.email || user.email || '').toLowerCase(),
      name,
      username,
      bio: bio || 'Привет! Я в Chiper 👋',
      avatar,
      avatarType: avatar && String(avatar).includes('video') ? 'video' : 'image',
      avatars: avatar ? [{ id: 'av_main', data: avatar, type: 'image' }] : [],
      coins: 0,
      stars: 0,
      verified: false,
      premium: false,
      premiumUntil: 0,
      isAdmin: false,
      avatarPosition: 'center',
      createdAt: Date.now(),
    };

    // Save to Firestore (payload aligned with your security rules)
    let saved = false;
    let cloudErr = null;
    try{
      if(!firebaseDb) initFirebase();
      if(!firebaseDb) throw new Error('Firestore недоступен');
      await fsSaveUser(user.uid, profile);
      saved = true;
    }catch(e){
      cloudErr = e;
      console.error('fsSaveUser', e);
      // Retry strictly rules-compliant create payload
      try{
        const un = normalizeUsername(profile.username).toLowerCase();
        await firebaseDb.collection('users').doc(user.uid).set({
          uid: user.uid,
          email: (profile.email || '').toLowerCase() || null,
          name: String(profile.name || '').trim().slice(0, 64),
          username: un,
          bio: String(profile.bio || '').slice(0, 500),
          isAdmin: false,
          coins: 0,
          stars: 0,
          verified: false,
          premium: false,
          premiumUntil: 0,
          createdAt: Date.now(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        // username index
        const h = un.replace(/^@/, '');
        try{
          await firebaseDb.collection('usernames').doc(h).set({
            uid: user.uid,
            username: un,
            email: (profile.email || '').toLowerCase() || null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }catch(_){}
        saved = true;
        cloudErr = null;
      }catch(e2){
        console.error('minimal save failed', e2);
        cloudErr = e2;
      }
    }
    try{ await fsSaveSettings(user.uid, state.settings || {}); }catch(_){}

    state.profile = profile;
    state.loggedIn = true;
    document.body.classList.add('authed');
    state.settings = state.settings || {
      theme:'system', accent:'purple', privacy:false, notifications:true,
      compact:false, themeSchedule:false, bubbleStyle:0
    };
    window._pendingReg = null;
    window._onboardAvatarData = null;

    try{ await loadChatsFromFirestore(); }catch(_){}
    go('chats');
    try{ renderChatList(); renderProfile(); updateCoinsUI(); subscribeFirestore(); }catch(_){}

    if(saved){
      showToast('Профиль создан ✓');
    } else {
      const code = cloudErr?.code || '';
      const msg = cloudErr?.message || String(cloudErr || '');
      console.error('Cloud save final error', code, msg);
      if(code === 'permission-denied' || /permission/i.test(msg)){
        showToast('Firestore: permission-denied');
      } else if(code === 'unavailable' || /network|offline/i.test(msg)){
        showToast('Нет сети — профиль только на устройстве');
      } else {
        showToast('Облако: ' + (code || msg || 'ошибка').toString().slice(0, 60));
      }
    }
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
    row.dataset.id = id;
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
  const archived = Object.entries(state.chats).filter(([,c])=>c.archived);
  if(!archived.length){
    list.innerHTML = `<div class="empty-state"><div class="emoji">📦</div><div class="title">Архив пуст</div><div class="desc">Свайпните чат влево или через меню «Архивировать»</div></div>`;
    return;
  }
  archived.forEach(([id,chat])=>{
    const contact = getContact(chat.contactId||id);
    const last = chat.messages[chat.messages.length-1];
    const row = document.createElement('div');
    row.className = 'chat-row glass r22 pressable';
    row.innerHTML = `
      <div class="avatar ${contact.gradient}" style="width:48px;height:48px;font-size:15px;">${contact.initials}</div>
      <div class="chat-meta">
        <div class="chat-top-line"><div class="chat-name">${escapeHtml(contact.name)}</div><div class="chat-time">${last?formatTime(last.ts):''}</div></div>
        <div class="chat-top-line"><div class="chat-last">${escapeHtml(formatLast(last||{}))}</div></div>
      </div>`;
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
  const nameEl = document.getElementById(isChannel ? 'channelName' : 'groupName');
  const title = (nameEl?.value || '').trim();
  if(title.length < 2){ showToast('Укажите название'); return; }
  if(isChannel && !isPremium() && countChannels() >= FREE_MAX_CHANNELS){
    showToast('Free: максимум ' + FREE_MAX_CHANNELS + ' канала · оформите Premium');
    go('premium');
    return;
  }
  const id = (isChannel ? 'ch_' : 'gr_') + Date.now().toString(36);
  let handle = '';
  let members = [];
  let bio = '';
  if(isChannel){
    handle = (document.getElementById('channelHandle')?.value || '').trim();
    if(!handle.startsWith('@')) handle = '@' + handle.replace(/^@/,'');
    handle = normalizeUsername(handle);
    if(handle.length < 3){ showToast('Укажите @handle канала'); return; }
    bio = (document.getElementById('channelDesc')?.value || '').trim() || 'Канал';
  } else {
    members = [...pendingGroupMembers];
    const me = getCurrentUserKey().replace(/^@/,'');
    if(me && !members.includes(me)) members.unshift(me);
    bio = (document.getElementById('groupDesc')?.value || '').trim() || 'Группа';
  }
  const meKey = getCurrentUserKey().replace(/^@/,'');
  state.chats[id] = {
    contactId: id,
    messages: [],
    unread: 0,
    archived: false,
    pinned: false,
    lastTs: Date.now(),
    title,
    handle,
    isGroup: !isChannel,
    isChannel,
    members,
    bio,
    avatar: isChannel ? channelAvatarData : groupAvatarData,
    subscribed: true,
    joined: true,
    subscribers: isChannel ? 1 : undefined,
    isPublic: isChannel ? (document.getElementById('channelPublicToggle')?.classList.contains('on') !== false) : true,
    createdBy: meKey,
    admins: [meKey],
    inviteToken: null,
    pinnedMsgId: null,
  };
  await persistChatMeta(id);
  const sys = {
    id: uid(), type:'text',
    text: isChannel
      ? `Канал «${title}» создан · ${handle}`
      : `Группа «${title}» создана` + (members.length ? ` · ${members.length} участн.` : ''),
    from: getCurrentUserKey(),
    out: true, ts: Date.now(), status: 'read'
  };
  await addMessage(id, sys);
  // reset form
  if(isChannel){
    document.getElementById('channelName').value = '';
    document.getElementById('channelHandle').value = '';
    if(document.getElementById('channelDesc')) document.getElementById('channelDesc').value = '';
    channelAvatarData = null;
    channelWizardNext(1);
  } else {
    document.getElementById('groupName').value = '';
    if(document.getElementById('groupDesc')) document.getElementById('groupDesc').value = '';
    pendingGroupMembers = [];
    groupAvatarData = null;
    renderGroupMemberChips();
    groupWizardNext(1);
  }
  showToast(isChannel ? 'Канал создан' : 'Группа создана');
  openChat(id);
}

