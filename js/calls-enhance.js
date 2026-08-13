/* Call UX enhancements: ICE from server, ring timeout, busy */
(function (global) {
  'use strict';

  let ringTimer = null;
  const RING_TIMEOUT_MS = 45000;

  async function loadIceServers() {
    try {
      const data = await (global.getJson ? global.getJson('/api/ice-servers') : null);
      if (data && Array.isArray(data.iceServers) && data.iceServers.length) return data.iceServers;
    } catch (_) {}
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
  }

  function clearRingTimer() {
    if (ringTimer) {
      clearTimeout(ringTimer);
      ringTimer = null;
    }
  }

  function startRingTimeout(onTimeout) {
    clearRingTimer();
    ringTimer = setTimeout(() => {
      ringTimer = null;
      if (typeof onTimeout === 'function') onTimeout();
      else if (typeof global.endCallReal === 'function') global.endCallReal();
      if (typeof global.showToast === 'function') global.showToast('Нет ответа');
    }, RING_TIMEOUT_MS);
  }

  function patchEnsureCallPc() {
    const prev = global.ensureCallPc;
    if (typeof prev !== 'function') return;
    global.ensureCallPc = async function (video) {
      if (global.callPc) return global.callPc;
      const iceServers = await loadIceServers();
      global.callPc = new RTCPeerConnection({ iceServers });
      global.callPc.onicecandidate = (ev) => {
        if (ev.candidate && typeof global.callSignalingSend === 'function') {
          global.callSignalingSend({
            type: 'call_ice',
            chatId: global.callChatId,
            candidate: ev.candidate.toJSON(),
          });
        }
      };
      global.callPc.ontrack = (ev) => {
        const remoteVid = document.getElementById('callRemoteVideo');
        if (remoteVid && ev.streams[0]) {
          remoteVid.srcObject = ev.streams[0];
          remoteVid.style.display = 'block';
        }
        clearRingTimer();
        const pulse = document.getElementById('callPulseRing');
        if (pulse) pulse.style.display = 'none';
      };
      global.callPc.onconnectionstatechange = () => {
        const st = global.callPc?.connectionState;
        if (st === 'connected') clearRingTimer();
        if (st === 'failed' || st === 'disconnected') {
          if (typeof global.showToast === 'function') global.showToast('Связь прервана');
        }
      };
      return global.callPc;
    };
  }

  function patchStartCallReal() {
    const prev = global.startCallReal;
    if (typeof prev !== 'function') return;
    global.startCallReal = async function (video) {
      if (global.callPc || global.callRole) {
        if (typeof global.showToast === 'function') global.showToast('Уже в звонке');
        return;
      }
      startRingTimeout(() => {
        if (typeof global.callSignalingSend === 'function' && global.callChatId) {
          global.callSignalingSend({ type: 'call_end', chatId: global.callChatId });
        }
        if (typeof global.endCallReal === 'function') global.endCallReal();
      });
      return prev.call(this, video);
    };
  }

  function patchEndCallReal() {
    const prev = global.endCallReal;
    if (typeof prev !== 'function') return;
    global.endCallReal = function () {
      clearRingTimer();
      return prev.apply(this, arguments);
    };
  }

  function init() {
    patchEnsureCallPc();
    patchStartCallReal();
    patchEndCallReal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 0);
  }

  global.ChiperCalls = { loadIceServers, startRingTimeout, clearRingTimer, init };
})(typeof window !== 'undefined' ? window : global);
