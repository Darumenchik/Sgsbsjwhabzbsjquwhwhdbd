/* ========== NAV ========== */
const AUTH_SCREENS = new Set(['login', 'register', 'onboarding']);
const APP_SCREENS = new Set(['chats','chat','settings','profile','profile-edit','storage','premium','customize','newchat','archive','gsearch','userinfo','admin']);

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
      if((name==='chats'||name==='archive') && n.getAttribute('aria-label')==='Чаты'){ n.classList.add('active'); targetBtn = n; }
      if((name==='profile'||name==='profile-edit') && n.getAttribute('aria-label')==='Профиль'){ n.classList.add('active'); targetBtn = n; }
      if(name==='settings' && n.getAttribute('aria-label')==='Настройки'){ n.classList.add('active'); targetBtn = n; }
      if(name==='newchat' && n.getAttribute('aria-label')==='Новый чат'){ n.classList.add('active'); targetBtn = n; }
    });
    if(targetBtn && nav.contains(targetBtn)) moveNavBubble(targetBtn);
  });

  if(name==='chats' || name==='chat'){
    if(window.innerWidth >= 900) document.getElementById('app').classList.add('desktop-chat');
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
  if(name==='gsearch'){ setTimeout(()=>{ document.getElementById('globalSearchInput')?.focus(); runGlobalSearch(); }, 50); }
  if(name==='admin'){
    if(!isAdminUser()){ showToast('Нет доступа'); go('settings'); return; }
    updateCoinsUI();
  }
  if(name==='settings'){
    renderPremium();
    updateCoinsUI();
    document.getElementById('privacyToggle')?.classList.toggle('on', state.settings.privacy);
    document.getElementById('notifToggle')?.classList.toggle('on', state.settings.notifications!==false);
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
      s.classList.toggle('active', s.dataset.c === (state.settings.accent || 'purple'));
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
      const pos = state.profile?.avatarPos || 'center';
      document.querySelectorAll('#avatarPosPicker .avatar-pos-btn').forEach(btn=>{
        btn.classList.toggle('active', btn.dataset.pos === pos);
      });
    }catch(_){}
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

