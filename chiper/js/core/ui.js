/* ========== PROFILE ========== */
function renderProfile(){
  const p = state.profile || {};
  const nameEl = document.getElementById('profileNameView');
  if(nameEl){
    nameEl.innerHTML = escapeHtml(p.name || 'Пользователь') + (typeof profileBadgesHTML==='function' ? profileBadgesHTML() : (isPremium() ? ' <span class="premium-badge">PRO</span>' : ''));
  }
  try{ renderAvatarGallery(); }catch(_){}
  const userView = document.getElementById('profileUserView');
  if(userView) userView.textContent = p.username || '@user';
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

  // Extra fields
  const bCard = document.getElementById('infoBirthdayCard');
  const bVal = document.getElementById('infoBirthday');
  if(bCard && bVal){
    if(p.birthday){
      bCard.style.display = '';
      try{
        const d = new Date(p.birthday + 'T00:00:00');
        bVal.textContent = d.toLocaleDateString('ru-RU', { day:'numeric', month:'long', year:'numeric' });
      }catch(_){ bVal.textContent = p.birthday; }
    } else { bCard.style.display = 'none'; }
  }
  const cCard = document.getElementById('infoCityCard');
  const cVal = document.getElementById('infoCity');
  if(cCard && cVal){
    if(p.city){ cCard.style.display = ''; cVal.textContent = p.city; }
    else cCard.style.display = 'none';
  }
  const extra = document.getElementById('profileExtraInfo');
  if(extra){
    const chips = [];
    if(p.gender){
      const gMap = { male:'♂ Мужской', female:'♀ Женский', other:'Другой' };
      chips.push(gMap[p.gender] || p.gender);
    }
    if(p.website) chips.push('🔗 ' + p.website.replace(/^https?:\/\//,''));
    if(p.phone) chips.push('📞 ' + p.phone);
    extra.innerHTML = chips.map(c => `<span style="font-size:12px;padding:4px 10px;border-radius:999px;background:var(--glass);color:var(--text-secondary);">${escapeHtml(c)}</span>`).join('');
  }

  setAvatarContent(document.getElementById('bigAvatar'), p);
  setAvatarContent(document.getElementById('miniAvatar'), p);
  setAvatarContent(document.getElementById('drawerAvatar'), p);
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

function applyBubbleStyle(){
  const style = Math.max(0, Math.min(9, +(state.settings?.bubbleStyle ?? 0)));
  for(let i=0;i<10;i++) document.body.classList.remove('bubble-style-'+i);
  document.body.classList.add('bubble-style-'+style);
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
    showToast('Стили пузырьков — функция Premium');
    go('premium');
    return;
  }
  if(!state.settings) state.settings = {};
  state.settings.bubbleStyle = id;
  saveMeta();
  applyBubbleStyle();
  renderBubbleStylePicker();
  showToast('Стиль «' + (BUBBLE_STYLES[id]?.name||id) + '»');
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
  if(sb) sb.textContent = supabaseClient ? 'подключён ✓' : (SUPABASE_URL ? 'ошибка ключей' : 'не подключён (локальный режим)');
}
async function clearAllStorage(){
  if(!confirm('Удалить локальный кэш интерфейса? Данные в Firestore останутся.')) return;
  try{
    // optional: delete only this user's chats from cloud — dangerous; just reload UI state
    state.chats = {};
    showToast('Локальный кэш очищен');
    renderChatList();
  }catch(_){}
  location.reload();
}

/* ========== SEARCH ========== */
function filterList(inputId, selector){
  const q = document.getElementById(inputId).value.trim().toLowerCase();
  document.querySelectorAll(selector).forEach(row=>{
    const name = row.getAttribute('data-name') || '';
    row.style.display = (!q || name.includes(q)) ? 'flex' : 'none';
  });
}
function toggleMsgSearch(){
  const bar = document.getElementById('msgSearchBar');
  bar.classList.toggle('active');
  if(bar.classList.contains('active')) document.getElementById('msgSearchInput').focus();
  else {
    document.getElementById('msgSearchInput').value='';
    document.querySelectorAll('.bubble.search-hit').forEach(b=>b.classList.remove('search-hit'));
  }
}
function searchInChat(){
  const q = document.getElementById('msgSearchInput').value.trim().toLowerCase();
  document.querySelectorAll('#messages .bubble').forEach(b=>{
    const text = b.textContent.toLowerCase();
    b.classList.toggle('search-hit', q && text.includes(q));
  });
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

/* ========== PARALLAX ORBS (light) ========== */
window.addEventListener('deviceorientation', (e)=>{
  const x = (e.gamma||0)/45, y = (e.beta||0)/45;
  document.querySelector('.orb1').style.transform = `translate(${x*12}px, ${y*8}px)`;
  document.querySelector('.orb2').style.transform = `translate(${-x*10}px, ${-y*6}px)`;
}, true);


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
  if(window.innerWidth < 700){
    const items = [];
    items.push({ label:'Ответить', icon:'↩', action:()=>setReply(m) });
    items.push({ label:'Реакция', icon:'😊', action:()=>showReactions(e, m) });
    if(isMessageOut(m) && m.type==='text') items.push({ label:'Изменить', icon:'✎', action:()=>editMsg(m.id) });
    items.push({ label:'Переслать', icon:'↪', action:()=>forwardMsg(m) });
    const ch = state.chats[state.currentChatId];
    if(ch && (ch.isChannel || ch.isGroup) && canPostInChat(ch)){
      if(ch.pinnedMsgId === m.id) items.push({ label:'Открепить', icon:'📌', action:()=>unpinMessage() });
      else items.push({ label:'Закрепить', icon:'📌', action:()=>pinMessage(m.id) });
    }
    items.push({ label:'Удалить', icon:'🗑', danger:true, action:()=>deleteMsg(m.id) });
    openSheet(items);
  } else if(_origShowMsgCtx) _origShowMsgCtx(e, m);
  else {
    // fallback to original logic inline
    const menu = document.getElementById('ctxMenu');
    const items = [];
    items.push({ label:'Ответить', icon:'↩', action:()=>setReply(m) });
    items.push({ label:'Реакция', icon:'😊', action:()=>showReactions(e, m) });
    if(isMessageOut(m) && m.type==='text') items.push({ label:'Изменить', icon:'✎', action:()=>editMsg(m.id) });
    items.push({ label:'Переслать', icon:'↪', action:()=>forwardMsg(m) });
    items.push({ label:'Удалить', icon:'🗑', danger:true, action:()=>deleteMsg(m.id) });
    menu.innerHTML = items.map(it=>`<div class="ctx-item ${it.danger?'danger':''}" role="menuitem">${it.icon} ${it.label}</div>`).join('');
    menu.querySelectorAll('.ctx-item').forEach((el,i)=>{ el.onclick = ()=>{ items[i].action(); hideCtx(); }; });
    positionMenu(menu, e);
    menu.classList.add('show');
  }
}

