/* ========== OPEN CHAT ========== */
function openChat(id){
  if(state.currentChatId && state.currentChatId !== id) saveDraft();
  state.currentChatId = id;
  const chat = state.chats[id];
  if(!chat) return;
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
  renderPinnedBar();
  loadDraft(id);
  updateChannelInputState();
  go('chat');
  document.getElementById('app').classList.add('has-chat', 'desktop-chat');
  if(navigator.vibrate) navigator.vibrate(8);
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
        older.reverse().forEach(m => box.insertBefore(createBubbleEl(m), box.firstChild.nextSibling));
        more.remove();
      };
      box.appendChild(more);
    }
    slice.forEach(m => box.appendChild(createBubbleEl(m)));
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
  b.className = 'bubble ' + (out ? 'out' : 'in glass') + ' r22 show';
  b.dataset.id = m.id;
  b.dataset.out = out ? '1' : '0';
  if(m.type==='voice'){
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
      html += `<div class="reply-quote"><b>${orig && isMessageOut(orig)?'Вы':getContact(state.chats[state.currentChatId]?.contactId).name}</b><br>${escapeHtml((orig?.text||'Голосовое/медиа').slice(0,60))}</div>`;
    }
    html += escapeHtml(m.text||'') + (m.edited?'<span class="edited-label">изм.</span>':'');
    html += `<span class="time">${timeStr(m)}${statusTicks(m)}</span>`;
    if(m.reactions && Object.keys(m.reactions).length){
      html += '<div class="reactions">'+Object.entries(m.reactions).map(([e,c])=>`<span class="reaction" data-e="${e}">${e} ${c>1?c:''}</span>`).join('')+'</div>';
    }
    b.innerHTML = html;
  }
  // interactions
  setupLongPress(b, (e)=> showMsgCtx(e, m));
  b.onclick = (e)=>{
    if(e.target.closest('.reaction')){
      const emoji = e.target.dataset.e;
      toggleReaction(m.id, emoji);
    }
  };
  // swipe to reply with visual feedback
  let startX=0, currentX=0, swiping=false;
  const replyIcon = document.createElement('div');
  replyIcon.className = 'swipe-reply-icon';
  replyIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 17l-5-5 5-5M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
  b.style.position = 'relative';
  b.appendChild(replyIcon);
  b.addEventListener('touchstart', e=>{
    startX = e.touches[0].clientX; currentX = startX; swiping = true;
    b.classList.add('swiping');
  }, {passive:true});
  b.addEventListener('touchmove', e=>{
    if(!swiping) return;
    currentX = e.touches[0].clientX;
    const dx = Math.max(0, Math.min(80, currentX - startX));
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
    if(dx > 55){ setReply(m); if(navigator.vibrate) navigator.vibrate(15); }
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
  const text = input.value.trim();
  if(!text) return;
  const chatId = state.currentChatId;
  const chat = state.chats[chatId];
  if(!chat) return;
  if(!canPostInChat(chat)){ showToast('Нет прав на отправку'); return; }
  const from = getCurrentUserKey();
  const msg = {
    id: uid(),
    type: 'text',
    text,
    from,
    out: true, // computed relative to sender; receivers recompute via isMessageOut
    ts: Date.now(),
    status: 'pending',
    replyTo: state.replyTo?.id || null,
  };
  input.value = '';
  onTypeInput();
  cancelReply();
  if(state.drafts) delete state.drafts[chatId];
  await addMessage(chatId, msg);
  const el = createBubbleEl(msg);
  document.getElementById('messages').appendChild(el);
  requestAnimationFrame(()=> el.classList.add('show'));
  scrollMessagesToBottom();
  if(navigator.vibrate) navigator.vibrate(12);
  const live = document.getElementById('ariaLive');
  if(live) live.textContent = 'Сообщение отправлено';

  setTimeout(async ()=>{ msg.status='sent'; updateBubbleStatus(msg); await updateMessage(chatId, msg.id, {status:'sent'}); }, 400);
  setTimeout(async ()=>{ msg.status='delivered'; updateBubbleStatus(msg); await updateMessage(chatId, msg.id, {status:'delivered'}); }, 900);
  setTimeout(async ()=>{ msg.status='read'; updateBubbleStatus(msg); await updateMessage(chatId, msg.id, {status:'read'}); }, 1800);
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
  document.getElementById('msgInput').focus();
}
function cancelReply(){
  state.replyTo = null;
  document.getElementById('replyBar').classList.remove('active');
}

function toggleReaction(msgId, emoji){
  const chat = state.chats[state.currentChatId];
  const m = chat?.messages.find(x=>x.id===msgId);
  if(!m) return;
  if(!m.reactions) m.reactions = {};
  m.reactions[emoji] = (m.reactions[emoji]||0) + 1;
  if(m.reactions[emoji] > 5) delete m.reactions[emoji];
  updateMessage(state.currentChatId, msgId, { reactions: m.reactions });
  renderMessages();
}

async function deleteMsg(msgId){
  const chatId = state.currentChatId;
  await removeMessage(chatId, msgId);
  renderMessages();
  showToast('Сообщение удалено');
}

async function editMsg(msgId){
  const chatId = state.currentChatId;
  const chat = state.chats[chatId];
  const m = chat?.messages.find(x=>x.id===msgId);
  if(!m || m.type!=='text' || !isMessageOut(m)) return;
  const newText = prompt('Редактировать:', m.text);
  if(newText!==null && newText.trim()){
    await updateMessage(chatId, msgId, { text: newText.trim(), edited: true });
    renderMessages();
    showToast('Изменено');
  }
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
        // strip media data ref handling is inside addMessage/persist
        addMessage(id, copy).then(() => showToast('Переслано → ' + c.name));
      }
    };
  });
  if(window.innerWidth < 700){
    openSheet(items);
  } else {
    // desktop: use bottom sheet still or ctx
    openSheet(items);
  }
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
  items.push({ label:'Ответить', icon:'↩', action:()=>setReply(m) });
  items.push({ label:'Реакция', icon:'😊', action:()=>showReactions(e, m) });
  if(isMessageOut(m) && m.type==='text') items.push({ label:'Изменить', icon:'✎', action:()=>editMsg(m.id) });
  items.push({ label:'Переслать', icon:'↪', action:()=>forwardMsg(m) });
  const chPin = state.chats[state.currentChatId];
  if(chPin && (chPin.isChannel || chPin.isGroup) && canPostInChat(chPin)){
    if(chPin.pinnedMsgId === m.id) items.push({ label:'Открепить', icon:'📌', action:()=>unpinMessage() });
    else items.push({ label:'Закрепить', icon:'📌', action:()=>pinMessage(m.id) });
  }
  items.push({ label:'Удалить', icon:'🗑', danger:true, action:()=>deleteMsg(m.id) });
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
    { label:'Удалить чат', danger:true, action:()=>{ delete state.chats[chatId]; if(firebaseDb){ const uid=state.profile?.uid; firebaseDb.collection('chats').doc(chatId).delete().catch(()=>{}); if(uid) firebaseDb.collection('userChats').doc(uid).collection('items').doc(chatId).delete().catch(()=>{}); } renderChatList(); } },
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
  const emojis = ['👍','❤️','😂','😮','😢','🔥','👏','🎉'];
  picker.innerHTML = emojis.map(em=>`<span data-e="${em}">${em}</span>`).join('');
  picker.querySelectorAll('span').forEach(s=>{
    s.onclick = ()=>{ toggleReaction(m.id, s.dataset.e); hideReactions(); };
  });
  const pt = e.touches?e.touches[0]:e;
  picker.style.left = Math.min(pt.clientX-80, window.innerWidth-220)+'px';
  picker.style.top = Math.max(pt.clientY-60, 20)+'px';
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

