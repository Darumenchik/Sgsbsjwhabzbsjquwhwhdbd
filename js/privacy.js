/* Privacy settings helpers */
(function (global) {
  'use strict';

  const DEFAULTS = {
    showLastSeen: true,
    showOnline: true,
    whoCanMessage: 'everyone', // everyone | contacts
    readReceipts: true,
  };

  function getPrivacy() {
    const s = (global.state && global.state.settings) || {};
    return { ...DEFAULTS, ...(s.privacyOpts || {}) };
  }

  function setPrivacy(partial) {
    if (!global.state) return;
    global.state.settings = global.state.settings || {};
    global.state.settings.privacyOpts = { ...getPrivacy(), ...partial };
    if (typeof global.saveMeta === 'function') global.saveMeta();
  }

  function canShowOnline(profile) {
    const p = getPrivacy();
    // Own setting applies to what WE broadcast; peers' privacy not fully known
    return !!p.showOnline;
  }

  function applyPrivacyForm() {
    const p = getPrivacy();
    const elSeen = document.getElementById('privLastSeen');
    const elOnline = document.getElementById('privOnline');
    const elMsg = document.getElementById('privWhoMessage');
    const elRead = document.getElementById('privReadReceipts');
    if (elSeen) elSeen.checked = !!p.showLastSeen;
    if (elOnline) elOnline.checked = !!p.showOnline;
    if (elMsg) elMsg.value = p.whoCanMessage || 'everyone';
    if (elRead) elRead.checked = !!p.readReceipts;
  }

  function savePrivacyForm() {
    setPrivacy({
      showLastSeen: !!document.getElementById('privLastSeen')?.checked,
      showOnline: !!document.getElementById('privOnline')?.checked,
      whoCanMessage: document.getElementById('privWhoMessage')?.value || 'everyone',
      readReceipts: !!document.getElementById('privReadReceipts')?.checked,
    });
    if (typeof global.showToast === 'function') global.showToast('Приватность сохранена');
  }

  global.ChiperPrivacy = {
    getPrivacy,
    setPrivacy,
    canShowOnline,
    applyPrivacyForm,
    savePrivacyForm,
    DEFAULTS,
  };
})(typeof window !== 'undefined' ? window : global);
