/* ========== WEBRTC CALLS ========== */
let callStream = null;
let callPc = null;
let callMuted = false;
let callCamOff = false;
let callIsVideo = false;
let callTimerInt = null;
let callStartedAt = 0;

async function startCall(video){
  const chatId = state.currentChatId;
  if(!chatId){ showToast('Откройте чат'); return; }
  const chat = state.chats[chatId];
  if(chat?.isChannel){ showToast('В каналы нельзя звонить'); return; }
  if(chat?.isGroup){ showToast('Групповые звонки скоро'); return; }
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
    showModal(video ? 'Нет доступа к камере' : 'Нет доступа к микрофону',
      'Разрешите доступ в настройках браузера для звонков.');
    return;
  }

  const localVid = document.getElementById('callLocalVideo');
  const remoteVid = document.getElementById('callRemoteVideo');
  if(video){
    localVid.srcObject = callStream;
    // Demo: mirror local stream as "remote" for single-device (real P2P needs signaling server)
    remoteVid.srcObject = callStream;
  }

  // WebRTC peer connection ready for real signaling
  try{
    callPc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    callStream.getTracks().forEach(t => callPc.addTrack(t, callStream));
    callPc.ontrack = (ev) => {
      if(remoteVid && ev.streams[0]) remoteVid.srcObject = ev.streams[0];
    };
    // Local demo offer (no remote peer without server)
    const offer = await callPc.createOffer();
    await callPc.setLocalDescription(offer);
    if(bc) bc.postMessage({ type: 'call_offer', chatId, sdp: offer, video, from: state.profile.username });
  }catch(_){}

  callStartedAt = Date.now();
  document.getElementById('callStatus').textContent = '00:00';
  callTimerInt = setInterval(()=>{
    const s = Math.floor((Date.now()-callStartedAt)/1000);
    document.getElementById('callStatus').textContent =
      String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
  }, 500);
  if(navigator.vibrate) navigator.vibrate([20,40,20]);
}

function toggleCallMute(){
  if(!callStream) return;
  callMuted = !callMuted;
  callStream.getAudioTracks().forEach(t => t.enabled = !callMuted);
  document.getElementById('callMuteBtn').classList.toggle('off', callMuted);
}

function toggleCallCam(){
  if(!callStream) return;
  callCamOff = !callCamOff;
  callStream.getVideoTracks().forEach(t => t.enabled = !callCamOff);
  document.getElementById('callCamBtn').classList.toggle('off', callCamOff);
  document.getElementById('callLocalVideo').style.opacity = callCamOff ? '0.3' : '1';
}
let callSpeakerOn = true;
function toggleCallSpeaker(){
  callSpeakerOn = !callSpeakerOn;
  document.getElementById('callSpeakerBtn')?.classList.toggle('off', !callSpeakerOn);
  // In real WebRTC: set remote audio element.volume / sinkId
  showToast(callSpeakerOn ? 'Динамик вкл.' : 'Динамик выкл.');
}

function endCall(){
  clearInterval(callTimerInt);
  if(callStream){ callStream.getTracks().forEach(t=>t.stop()); callStream = null; }
  if(callPc){ try{ callPc.close(); }catch(_){} callPc = null; }
  const localVid = document.getElementById('callLocalVideo');
  const remoteVid = document.getElementById('callRemoteVideo');
  if(localVid) localVid.srcObject = null;
  if(remoteVid) remoteVid.srcObject = null;
  document.getElementById('callOverlay').classList.remove('active');
  if(bc) bc.postMessage({ type: 'call_end', chatId: state.currentChatId });
}


