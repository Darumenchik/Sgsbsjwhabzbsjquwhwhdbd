/* Unified message send pipeline: local → server/WS → status */
(function (global) {
  'use strict';

  async function sendTextUnified(chatId, text, opts) {
    opts = opts || {};
    const state = global.state;
    if (!state || !chatId || !text) throw new Error('bad args');
    const chat = state.chats[chatId];
    if (!chat) throw new Error('chat not found');
    if (typeof global.canPostInChat === 'function' && !global.canPostInChat(chat)) {
      throw new Error('Нет прав на отправку');
    }

    const clientMsgId = (global.uid && global.uid()) || ('m' + Date.now().toString(36));
    const from = global.getCurrentUserKey ? global.getCurrentUserKey() : state.profile?.username;
    const msg = {
      id: clientMsgId,
      type: 'text',
      text: String(text),
      from,
      out: true,
      ts: Date.now(),
      status: 'pending',
      replyTo: opts.replyTo || state.replyTo?.id || null,
      clientMsgId,
    };

    if (typeof global.addMessage === 'function') await global.addMessage(chatId, msg);
    else {
      chat.messages = chat.messages || [];
      chat.messages.push(msg);
    }

    const serverConvId =
      (global.resolveServerChatId && global.resolveServerChatId(chatId)) ||
      chat.serverId ||
      (global.ChiperCore && global.ChiperCore.isUuid(chatId) ? chatId : null);

    const payload = {
      conversation_id: serverConvId,
      content: msg.text,
      message_type: 'text',
      client_msg_id: clientMsgId,
      reply_to: msg.replyTo || null,
    };

    const tryServer = async () => {
      if (!payload.conversation_id) throw new Error('no server conversation');
      return global.postJson('/api/messages', payload);
    };

    try {
      if (chat.isGroup || chat.isChannel) {
        if (navigator.onLine === false) {
          if (global.ChiperCore) global.ChiperCore.enqueueOutbox({ type: 'message', payload: { ...payload, _localChatId: chatId, _localMsgId: clientMsgId } });
          msg.status = 'pending';
        } else {
          const res = await tryServer();
          if (res && res.message && res.message.id) msg.serverId = res.message.id;
          msg.status = 'sent';
          if (typeof global.updateMessage === 'function') await global.updateMessage(chatId, msg.id, { status: 'sent', serverId: msg.serverId });
        }
      } else if (typeof global.encryptAndSendMessage === 'function' && chat.contactId) {
        // DM / E2EE path — still encrypted; not group plaintext
        if (navigator.onLine === false) {
          if (global.ChiperCore) {
            global.ChiperCore.enqueueOutbox({ type: 'e2ee', chatId, msg });
          }
          msg.status = 'pending';
        } else {
          await global.encryptAndSendMessage(chatId, msg);
          msg.status = 'sent';
          if (typeof global.updateMessage === 'function') await global.updateMessage(chatId, msg.id, { status: 'sent' });
        }
      } else {
        msg.status = 'sent';
      }
    } catch (e) {
      if (global.ChiperCore) {
        global.ChiperCore.enqueueOutbox({
          type: 'message',
          payload: { ...payload, _localChatId: chatId, _localMsgId: clientMsgId },
        });
        msg.status = 'pending';
      } else {
        msg.status = 'failed';
      }
      throw e;
    }

    return msg;
  }

  function handleMessageReceipt(msg) {
    if (!msg || !global.state) return;
    const convId = msg.conversationId;
    const localId = (global.resolveLocalChatId && convId && global.resolveLocalChatId(convId)) || convId;
    const chat = (localId && global.state.chats[localId]) || (convId && global.state.chats[convId]);
    if (!chat || !Array.isArray(chat.messages)) return;
    const m = chat.messages.find((x) => x.id === msg.messageId || x.serverId === msg.messageId);
    if (!m) return;
    if (msg.status === 'delivered' || msg.status === 'read') {
      m.status = msg.status;
      if (typeof global.updateBubbleStatus === 'function') global.updateBubbleStatus(m);
    }
  }

  global.ChiperMessages = {
    sendTextUnified,
    handleMessageReceipt,
  };
})(typeof window !== 'undefined' ? window : global);
