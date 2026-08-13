/* Chiper sync layer — conversations + recent messages after login */
(function (global) {
  'use strict';

  async function syncConversationsFromServer() {
    if (!global.state || !global.state.loggedIn) return { count: 0 };
    const myId = global.getMyProfileId ? global.getMyProfileId() : global.state.profile?.id;
    if (!myId) return { count: 0 };
    try {
      const res = await (global.getJson
        ? global.getJson('/api/conversations')
        : fetch('/api/conversations').then((r) => r.json()));
      const list = Array.isArray(res.conversations) ? res.conversations : [];
      let n = 0;
      for (const conv of list) {
        if (!conv || !conv.id) continue;
        const chatId = conv.id;
        if (!global.state.chats[chatId]) {
          global.state.chats[chatId] = {
            contactId: chatId,
            messages: [],
            unread: 0,
            archived: !!conv.archived,
            pinned: !!conv.pinned,
            muted: !!conv.muted,
            lastTs: conv.last_message_at ? new Date(conv.last_message_at).getTime() : Date.now(),
            title: conv.name || (conv.type === 'dm' ? 'Личный чат' : 'Чат'),
            isGroup: conv.type === 'group',
            isChannel: conv.type === 'channel',
            bio: conv.description || null,
            serverId: conv.id,
            subscribed: true,
            joined: true,
          };
          n++;
        } else {
          global.state.chats[chatId].serverId = conv.id;
          if (conv.name) global.state.chats[chatId].title = global.state.chats[chatId].title || conv.name;
          global.state.chats[chatId].isGroup = global.state.chats[chatId].isGroup || conv.type === 'group';
          global.state.chats[chatId].isChannel = global.state.chats[chatId].isChannel || conv.type === 'channel';
        }
        if (typeof global.linkChatIds === 'function') {
          const local = global.resolveLocalChatId ? global.resolveLocalChatId(chatId) : chatId;
          if (local && local !== chatId) global.linkChatIds(local, chatId);
        }
        if (typeof global.persistChatMeta === 'function') {
          try { await global.persistChatMeta(chatId); } catch (_) {}
        }
      }
      if (typeof global.renderChatList === 'function') global.renderChatList();
      return { count: list.length, added: n };
    } catch (e) {
      console.warn('syncConversationsFromServer', e);
      return { count: 0, error: e.message };
    }
  }

  async function syncMessagesForChat(chatId, limit) {
    if (!chatId || !global.state) return [];
    const serverId =
      (global.resolveServerChatId && global.resolveServerChatId(chatId)) ||
      global.state.chats[chatId]?.serverId ||
      chatId;
    const isUuid = global.ChiperCore && global.ChiperCore.isUuid
      ? global.ChiperCore.isUuid(serverId)
      : /^[0-9a-f-]{36}$/i.test(String(serverId));
    if (!isUuid) return [];
    try {
      const res = await global.getJson(
        `/api/messages?conversation_id=${encodeURIComponent(serverId)}&limit=${limit || 50}`
      );
      const rows = Array.isArray(res.messages) ? res.messages : [];
      const chat = global.state.chats[chatId] || global.state.chats[serverId];
      if (!chat) return rows;
      chat.messages = chat.messages || [];
      const have = new Set(chat.messages.map((m) => m.id));
      for (const row of rows) {
        if (!row || !row.id || have.has(row.id)) continue;
        chat.messages.push({
          id: row.id,
          type: row.message_type || 'text',
          text: row.content || '',
          from: row.sender_id,
          out: String(row.sender_id) === String(global.getMyProfileId && global.getMyProfileId()),
          ts: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
          status: 'delivered',
          serverId: row.id,
        });
        have.add(row.id);
      }
      chat.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (typeof global.persistChatMeta === 'function') {
        try { await global.persistChatMeta(chatId); } catch (_) {}
      }
      return rows;
    } catch (e) {
      console.warn('syncMessagesForChat', e);
      return [];
    }
  }

  async function fullSyncAfterLogin() {
    const conv = await syncConversationsFromServer();
    // Refresh token opportunistically
    try {
      if (global.postJson) {
        const r = await global.postJson('/api/auth/refresh', {});
        if (r && r.token && global.state?.profile?.email) {
          const acc = global.loadAccounts ? global.loadAccounts() : {};
          const em = String(global.state.profile.email).toLowerCase();
          if (acc[em]) {
            acc[em].token = r.token;
            if (global.saveAccounts) global.saveAccounts(acc);
          }
        }
      }
    } catch (_) {}
    return conv;
  }

  global.ChiperSync = {
    syncConversationsFromServer,
    syncMessagesForChat,
    fullSyncAfterLogin,
  };
})(typeof window !== 'undefined' ? window : global);
