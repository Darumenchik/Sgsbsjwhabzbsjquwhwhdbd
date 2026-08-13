/* ========== CHIPER COINS / BADGES / ADMIN / AVATARS / REAL WEBRTC ========== */
const ADMIN_EMAILS = ['gapspapspspsp10374hsi@gmail.com'];
const ADMIN_USERNAMES = ['gapspapspspsp10374hsi'];
const PREMIUM_PRICE_MONTH_CC = 300;
const PREMIUM_PRICE_YEAR_CC = 2500;
const MAX_AVATARS = 5;
let adminTargetKey = null; // email or username key in accounts
let pendingOffer = null;
let pendingOfferFrom = null;
let callChatId = null;
let callRole = null; // 'caller' | 'callee'
let iceBuf = [];

function isAdminUser(){
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
  const badge = document.getElementById('settingsCoinBadge');
  if(badge) badge.textContent = c + ' CC';
  const my = document.getElementById('myCoinsLabel');
  if(my) my.textContent = 'Баланс: ' + c + ' CC · ★ ' + s;
  const price = document.getElementById('premiumCoinPriceLabel');
  if(price) price.textContent = selectedPremiumPlan === 'year'
    ? '(' + PREMIUM_PRICE_YEAR_CC + ' CC / год)'
    : '(' + PREMIUM_PRICE_MONTH_CC + ' CC / мес)';
  const adminRow = document.getElementById('adminSettingsRow');
  if(adminRow) adminRow.style.display = isAdminUser() ? '' : 'none';
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
  updateCoinsUI();
  renderPremium();
  renderProfile();
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
  if(!p && fs()){
    try{
      const uname = await firebaseDb.collection('usernames').doc(q).get();
      if(uname.exists){
        const uid = uname.data().uid;
        p = await fsGetUser(uid);
        if(p) adminTargetKey = uid;
      }
      if(!p){
        // try email equality
        const qs = await firebaseDb.collection('users').where('email', '==', q).limit(1).get();
        if(!qs.empty){ p = qs.docs[0].data(); adminTargetKey = qs.docs[0].id; }
      }
    }catch(e){ console.warn(e); }
  }
  if(!p){
    box.innerHTML = '<div class="hint-text">Не найден в Firestore</div>';
    if(actions) actions.style.display='none';
    adminTargetKey = null;
    window._adminTargetProfile = null;
    return;
  }
  window._adminTargetProfile = p;
  box.innerHTML = `<div class="info-card glass r20"><div class="k">${escapeHtml(p.name||'')}</div>
    <div class="v">${escapeHtml(p.username||adminTargetKey)}</div>
    <div class="hint-text" style="margin-top:6px;">CC: ${+(p.coins||0)} · ★ ${+(p.stars||0)} · ${p.verified?'✓':'без галочки'} · ${p.premium?'PRO':'Free'}</div></div>`;
  if(actions){
    actions.style.display = '';
    document.getElementById('adminTargetLabel').textContent = (p.username || adminTargetKey) + '';
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
    await persistProfileToAccounts();
  } else if(t.uid){
    await fsSaveUser(t.uid, t.profile);
    if(state.profile?.uid === t.uid){
      Object.assign(state.profile, t.profile);
    }
  }
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

/* ---- Real WebRTC via BroadcastChannel + optional Firestore ---- */
function callSignalingSend(payload){
  const msg = { ...payload, from: state.profile?.username || 'user', ts: Date.now() };
  if(bc) bc.postMessage(msg);
  // Firestore signaling for cross-device when available
  try{
    if(firebaseDb && payload.chatId){
      firebaseDb.collection('calls').doc(payload.chatId).collection('signals').add({
        ...msg,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(()=>{});
    }
  }catch(_){}
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
  if(callStream){ callStream.getTracks().forEach(t=>t.stop()); callStream = null; }
  if(callPc){ try{ callPc.close(); }catch(_){} callPc = null; }
  const localVid = document.getElementById('callLocalVideo');
  const remoteVid = document.getElementById('callRemoteVideo');
  if(localVid) localVid.srcObject = null;
  if(remoteVid) remoteVid.srcObject = null;
  document.getElementById('callOverlay')?.classList.remove('active');
  document.getElementById('incomingCallBanner')?.classList.remove('show');
  if(callChatId) callSignalingSend({ type: 'call_end', chatId: callChatId });
  callChatId = null;
  callRole = null;
  pendingOffer = null;
  iceBuf = [];
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


