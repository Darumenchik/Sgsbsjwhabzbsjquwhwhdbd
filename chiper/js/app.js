/* ========== INIT ========== */
(async function init(){
  // Start locked until Firebase confirms a real profile
  state.loggedIn = false;
  document.body.classList.remove('authed');
  document.querySelectorAll('.screen.active').forEach(s => s.classList.remove('active'));
  const loginScreen = document.getElementById('screen-login');
  if(loginScreen) loginScreen.classList.add('active');

  try{
    initFirebase();
    await loadState();
    await initSupabase();
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

// Desktop detection
if(window.innerWidth >= 900) document.body.classList.add('desktop');
window.addEventListener('resize', ()=>{
  document.body.classList.toggle('desktop', window.innerWidth>=900);
  document.querySelectorAll('.bottom-nav').forEach(nav=>{
    const active = nav.querySelector('.nav-item.active');
    if(active){
      active._navInit = true;
      moveNavBubble(active);
    }
  });
});
