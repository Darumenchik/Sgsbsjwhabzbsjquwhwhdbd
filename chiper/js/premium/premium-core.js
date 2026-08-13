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

