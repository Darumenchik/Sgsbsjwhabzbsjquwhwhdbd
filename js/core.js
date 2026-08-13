/* ========== CHIPER CORE v1 ==========
   Shared utilities: profile identity, chat id map, API retry,
   offline queue, network banner, debounce, skeletons.
   Loaded before js/app.js
*/
(function (global) {
  'use strict';

  const CHAT_MAP_KEY = 'chiper_chat_map_v1';
  const OUTBOX_KEY = 'chiper_outbox_v1';

  // ---------- Profile identity ----------
  function getMyProfileId() {
    const p = global.state && global.state.profile;
    if (!p) return null;
    return p.id || p.uid || null;
  }

  function normalizePeerUsername(u) {
    return String(u || '').trim().replace(/^@+/, '').toLowerCase();
  }

  function isUuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
  }

  /** Merge server profile fields onto local profile; prefer server UUID as id */
  function normalizeProfile(local, remote) {
    const base = { ...(local || {}), ...(remote || {}) };
    if (remote && remote.id) base.id = remote.id;
    if (!base.uid && base.id) base.uid = base.id;
    if (base.username) base.username = String(base.username).startsWith('@')
      ? base.username
      : '@' + String(base.username).replace(/^@/, '');
    return base;
  }

  // ---------- Chat id mapping (local ↔ server) ----------
  function loadChatMap() {
    try {
      return JSON.parse(localStorage.getItem(CHAT_MAP_KEY) || '{}') || {};
    } catch (_) {
      return {};
    }
  }

  function saveChatMap(map) {
    try {
      localStorage.setItem(CHAT_MAP_KEY, JSON.stringify(map || {}));
    } catch (_) {}
  }

  function linkChatIds(localId, serverId) {
    if (!localId || !serverId) return;
    const map = loadChatMap();
    map.localToServer = map.localToServer || {};
    map.serverToLocal = map.serverToLocal || {};
    map.localToServer[localId] = serverId;
    map.serverToLocal[serverId] = localId;
    saveChatMap(map);
  }

  function resolveServerChatId(localOrServerId) {
    if (!localOrServerId) return null;
    if (isUuid(localOrServerId)) return localOrServerId;
    const map = loadChatMap();
    return (map.localToServer && map.localToServer[localOrServerId]) || null;
  }

  function resolveLocalChatId(serverId) {
    if (!serverId) return null;
    const map = loadChatMap();
    return (map.serverToLocal && map.serverToLocal[serverId]) || serverId;
  }

  // ---------- Debounce / throttle ----------
  function debounce(fn, ms) {
    let t = null;
    const wrapped = function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  }

  // ---------- Offline outbox ----------
  function loadOutbox() {
    try {
      return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]') || [];
    } catch (_) {
      return [];
    }
  }

  function saveOutbox(list) {
    try {
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(list || []));
    } catch (_) {}
  }

  function enqueueOutbox(item) {
    const list = loadOutbox();
    list.push({ ...item, queuedAt: Date.now(), attempts: 0 });
    saveOutbox(list);
    updateOfflineBanner();
    return list.length;
  }

  async function flushOutbox(sendFn) {
    if (!navigator.onLine) return { sent: 0, left: loadOutbox().length };
    let list = loadOutbox();
    if (!list.length) return { sent: 0, left: 0 };
    const remain = [];
    let sent = 0;
    for (const item of list) {
      try {
        if (typeof sendFn === 'function') await sendFn(item);
        sent++;
      } catch (e) {
        item.attempts = (item.attempts || 0) + 1;
        item.lastError = e && e.message;
        if (item.attempts < 8) remain.push(item);
      }
    }
    saveOutbox(remain);
    updateOfflineBanner();
    return { sent, left: remain.length };
  }

  // ---------- Network banner ----------
  function ensureOfflineBanner() {
    let el = document.getElementById('offlineBanner');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'offlineBanner';
    el.setAttribute('role', 'status');
    el.style.cssText = [
      'display:none',
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:9999',
      'padding:10px 16px',
      'text-align:center',
      'font-size:13px',
      'font-weight:600',
      'background:#b45309',
      'color:#fff',
      'box-shadow:0 4px 16px rgba(0,0,0,.25)',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  function updateOfflineBanner() {
    const el = ensureOfflineBanner();
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const pending = loadOutbox().length;
    if (offline) {
      el.style.display = 'block';
      el.textContent = pending
        ? `Нет сети · в очереди ${pending} сообщ.`
        : 'Нет сети · сообщения сохранятся локально';
    } else if (pending > 0) {
      el.style.display = 'block';
      el.style.background = '#7C3AED';
      el.textContent = `Отправка очереди… (${pending})`;
    } else {
      el.style.display = 'none';
      el.style.background = '#b45309';
    }
  }

  function initNetworkListeners(onOnline) {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => {
      updateOfflineBanner();
      if (typeof onOnline === 'function') onOnline();
    });
    window.addEventListener('offline', updateOfflineBanner);
    updateOfflineBanner();
  }

  // ---------- API with retry ----------
  async function apiFetch(url, options = {}, retries = 2) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        if (typeof global.fetchJson === 'function') {
          return await global.fetchJson(url, options);
        }
        const res = await fetch(url, options);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
        return data;
      } catch (e) {
        lastErr = e;
        if (i < retries) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw lastErr;
  }

  // ---------- Skeleton / empty helpers ----------
  function skeletonListHtml(n = 5) {
    return Array.from({ length: n })
      .map(
        () =>
          `<div class="skel-row" aria-hidden="true">
            <div class="skel circle"></div>
            <div class="skel-lines"><div class="skel line"></div><div class="skel line short"></div></div>
          </div>`
      )
      .join('');
  }

  function emptyStateHtml(title, subtitle, btnLabel, btnAction) {
    const action = btnAction
      ? `<button type="button" class="gradient-btn r20" style="margin-top:12px;padding:10px 18px;" onclick="${btnAction}">${btnLabel || 'OK'}</button>`
      : '';
    return `<div class="empty-state" style="text-align:center;padding:40px 20px;color:var(--text-secondary);">
      <div style="font-size:40px;margin-bottom:12px;opacity:.5;">💬</div>
      <div style="font-weight:700;font-size:16px;color:var(--text);margin-bottom:6px;">${title}</div>
      <div style="font-size:13px;line-height:1.4;">${subtitle || ''}</div>
      ${action}
    </div>`;
  }

  // ---------- Image compress for upload ----------
  function compressImageFile(file, maxSide = 1280, quality = 0.82) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith('image/')) {
        resolve(file);
        return;
      }
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        const scale = Math.min(1, maxSide / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              resolve(file);
              return;
            }
            resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
          },
          'image/jpeg',
          quality
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  // Export
  const Core = {
    getMyProfileId,
    normalizePeerUsername,
    isUuid,
    normalizeProfile,
    loadChatMap,
    saveChatMap,
    linkChatIds,
    resolveServerChatId,
    resolveLocalChatId,
    debounce,
    loadOutbox,
    saveOutbox,
    enqueueOutbox,
    flushOutbox,
    updateOfflineBanner,
    initNetworkListeners,
    apiFetch,
    skeletonListHtml,
    emptyStateHtml,
    compressImageFile,
  };

  global.ChiperCore = Core;
  // Convenience globals used by app.js
  global.getMyProfileId = getMyProfileId;
  global.normalizePeerUsername = normalizePeerUsername;
  global.linkChatIds = linkChatIds;
  global.resolveServerChatId = resolveServerChatId;
  global.resolveLocalChatId = resolveLocalChatId;
})(typeof window !== 'undefined' ? window : global);
