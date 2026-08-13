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
  const a = state.settings.accent || 'purple';
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

