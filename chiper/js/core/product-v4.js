/* ========== CHIPER v4 PRODUCT LAYER ========== */
state.drafts = state.drafts || {};
state.settings = Object.assign({
  theme: 'system', accent: 'purple', privacy: false, notifications: true,
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
  if(!m){ bar.classList.remove('show'); return; }
  document.getElementById('pinnedText').textContent = m.text || formatLast(m);
  bar.classList.add('show');
}
function scrollToPinned(){
  const chat = state.chats[state.currentChatId];
  if(!chat?.pinnedMsgId) return;
  const el = document.querySelector(`.bubble[data-id="${chat.pinnedMsgId}"]`);
  if(el){ el.scrollIntoView({behavior:'smooth', block:'center'}); el.classList.add('selected'); setTimeout(()=>el.classList.remove('selected'), 1200); }
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
  document.getElementById('checkoutFlow').style.display = 'block';
  document.getElementById('buyPremiumBtn').style.display = 'none';
  document.getElementById('checkoutStep1').style.display = '';
  document.getElementById('checkoutStep2').style.display = 'none';
  document.getElementById('ckStep1').classList.add('on');
  document.getElementById('ckStep2').classList.remove('on');
  const plan = selectedPremiumPlan === 'year' ? '999 ₽ / год' : '149 ₽ / мес';
  document.getElementById('ckPlanLabel').textContent = plan;
  document.getElementById('checkoutFlow').scrollIntoView({behavior:'smooth'});
}
function checkoutNext(){
  document.getElementById('checkoutStep1').style.display = 'none';
  document.getElementById('checkoutStep2').style.display = '';
  document.getElementById('ckStep2').classList.add('on');
}
function cancelCheckout(){
  document.getElementById('checkoutFlow').style.display = 'none';
  document.getElementById('buyPremiumBtn').style.display = 'block';
}
function checkoutConfirm(){
  const days = selectedPremiumPlan === 'year' ? 365 : 30;
  state.profile.premium = true;
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

/* PWA service worker registration (inline) */
function registerPWA(){
  if(!('serviceWorker' in navigator)) return;
  const swCode = `
    const CACHE='chiper-shell-v4';
    self.addEventListener('install', e=>{ self.skipWaiting(); });
    self.addEventListener('activate', e=>{ e.waitUntil(clients.claim()); });
    self.addEventListener('fetch', e=>{
      // network-first for navigations; cache shell is limited for file:// 
    });
  `;
  try{
    const blob = new Blob([swCode], {type:'application/javascript'});
    const url = URL.createObjectURL(blob);
    navigator.serviceWorker.register(url).catch(()=>{});
  }catch(_){}
}

/* Keyboard shortcut Ctrl/Cmd+K global search */
document.addEventListener('keydown', e=>{
  if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){
    e.preventDefault();
    go('gsearch');
    setTimeout(()=>document.getElementById('globalSearchInput')?.focus(), 100);
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



