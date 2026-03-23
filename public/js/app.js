// public/js/app.js

let deviceId = localStorage.getItem('deepmatch_device_id');
if (!deviceId) {
    deviceId = 'user_' + Math.random().toString(36).substr(2, 9) + Date.now();
    localStorage.setItem('deepmatch_device_id', deviceId);
}

const socket = io({
    auth: { deviceId: deviceId },
    reconnection: true,
    reconnectionAttempts: Infinity,
    timeout: 20000,
    transports: ['websocket'] 
});

let currentRoom = null;
let currentLang = 'zh';
let myAvatarUrl = '', partnerAvatarUrl = '';
let isGroupChat = false; 
let typingTimeout = null;
const STORAGE_KEY = 'deepmatch_session';

const getAvatar = (seed) => `https://api.dicebear.com/9.x/notionists/svg?seed=${seed}&backgroundColor=e6f7ff,ffe4e4,e6ffe6`;

function saveSession(data) { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
function getSession() { const d = localStorage.getItem(STORAGE_KEY); return d ? JSON.parse(d) : null; }
function appendMsg(msg) { const s = getSession(); if (s) { s.messages.push(msg); saveSession(s); } }

window.clearSession = function() { localStorage.removeItem(STORAGE_KEY); location.reload(); };

window.toggleLanguage = function() {
    currentLang = currentLang === 'zh' ? 'en' : 'zh';
    document.getElementById('current-lang-text').innerText = currentLang === 'zh' ? 'EN' : '中';
    updatePageText();
};

function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    const toolbar = document.getElementById('topToolbar');
    if (toolbar) toolbar.style.display = (id === 'page-chat') ? 'none' : 'flex';
}

function updatePageText() {
    const t = window.translations[currentLang];
    if (!t) return;
    document.querySelectorAll('[data-i18n]').forEach(el => {
        if (t[el.getAttribute('data-i18n')]) el.innerText = t[el.getAttribute('data-i18n')];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        if (t[el.getAttribute('data-i18n-placeholder')]) el.placeholder = t[el.getAttribute('data-i18n-placeholder')];
    });
}

function scrollToBottom() {
    const el = document.getElementById('chatBody');
    el.scrollTop = el.scrollHeight;
}

function renderMessage(text, type, time, avatarUrl) {
    const chatBody = document.getElementById('chatBody');
    const row = document.createElement('div');
    row.className = `msg-row ${type}`;
    
    if (type === 'system') {
        row.innerHTML = `<div class="msg-system-bubble">${text}</div>`;
    } else {
        row.innerHTML = `
            <div class="avatar"><img src="${avatarUrl}" alt="Avatar"></div>
            <div class="msg-content">
                <div class="msg-bubble">${text}</div>
                <span class="msg-time">${time}</span>
            </div>
        `;
    }
    chatBody.appendChild(row);
    scrollToBottom();
}

function enableChatInput() {
    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.querySelector('.input-bar button');
    if (chatInput) {
        chatInput.disabled = false;
        chatInput.placeholder = window.translations[currentLang].chatPlaceholder;
    }
    if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.style.background = "var(--ds-blue)";
    }
}

function showInviteNotification(data) {
    const container = document.getElementById('notification-area');
    if (!container) return;

    const card = document.createElement('div');
    card.className = 'invite-card';
    card.innerHTML = `
        <div class="title">👋 发现共同话题</div>
        <div class="info">有人正在聊 <b>${data.topic}</b>，是否加入？</div>
        <div class="invite-actions">
            <button class="btn-accept">立即加入</button>
            <button class="btn-decline">忽略</button>
        </div>
    `;

    card.querySelector('.btn-accept').onclick = () => {
        socket.emit('accept_invite', { inviterId: data.inviterId });
        card.remove();
        showPage('page-loading');
        document.getElementById('loading-text').innerText = "正在连接对方...";
    };

    card.querySelector('.btn-decline').onclick = () => {
        socket.emit('decline_invite', { inviterId: data.inviterId });
        card.remove();
    };

    setTimeout(() => { if(document.body.contains(card)) card.remove(); }, 15000);
    container.appendChild(card);
}

window.startMatching = function() {
    const input = document.getElementById('userInput').value.trim();
    showPage('page-loading');
    const topic = input ? `"${input}"` : (currentLang === 'zh' ? "综合大厅" : "General");
    document.getElementById('loading-text').innerHTML = `${window.translations[currentLang].loadingPrefix} <b>${topic}</b> ${window.translations[currentLang].loadingSuffix}`;
    socket.emit('search_match', input);
};

window.sendMsg = function() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    renderMessage(text, 'me', time, myAvatarUrl);
    appendMsg({ text, type: 'me', time, avatar: myAvatarUrl });
    socket.emit('chat_message', { room: currentRoom, msg: text, time, avatar: myAvatarUrl });
    input.value = '';
};

// === Socket 监听 ===
socket.on('connect', () => {
    document.getElementById('offline-tip').style.display = 'none';
    if (currentRoom) socket.emit('rejoin_room', currentRoom);
});
socket.on('disconnect', () => document.getElementById('offline-tip').style.display = 'block');
socket.on('online_count', (c) => { const el = document.getElementById('online-count'); if(el) el.innerText = c; });

// 📌 监听 1v1 单聊
socket.on('match_found', (data) => {
    enableChatInput(); 
    isGroupChat = false;
    currentRoom = data.room;
    myAvatarUrl = getAvatar(data.myAvatar);
    partnerAvatarUrl = getAvatar(data.partnerAvatar);
    
    saveSession({ roomId: data.room, myAvatar: myAvatarUrl, partnerAvatar: partnerAvatarUrl, keyword: data.keyword, isGroupChat: false, messages:[] });

    const avatarEl = document.getElementById('avatar-container');
    if(avatarEl) avatarEl.style.display = 'block';
    document.getElementById('partner-avatar-img').src = partnerAvatarUrl;
    document.getElementById('partner-name').innerText = window.translations[currentLang].partnerName;
    document.getElementById('match-status').innerText = window.translations[currentLang].matchSuccess;
    document.getElementById('match-status').style.color = "#22c55e";
    
    document.getElementById('chatBody').innerHTML = `<div class="msg-system-bubble">${window.translations[currentLang].matchTopic} <b>${data.keyword}</b></div>`;
    showPage('page-chat');
});

// 📌 监听 群聊
socket.on('group_match_success', (data) => {
    enableChatInput(); 
    isGroupChat = true;
    currentRoom = data.room;
    myAvatarUrl = getAvatar(data.myAvatarSeed);
    partnerAvatarUrl = '';
    
    saveSession({ roomId: data.room, myAvatar: myAvatarUrl, partnerAvatar: '', keyword: data.keyword, isGroupChat: true, messages:[] });

    const avatarEl = document.getElementById('avatar-container');
    if(avatarEl) avatarEl.style.display = 'none';
    document.getElementById('partner-name').innerText = `💬 频道: #${data.keyword}`;
    document.getElementById('match-status').innerText = `● 当前 ${data.memberCount} 人在线`;
    document.getElementById('match-status').style.color = "#22c55e";
    
    document.getElementById('chatBody').innerHTML = `<div class="msg-system-bubble">欢迎来到 <b>${data.keyword}</b> 群聊频道</div>`;
    showPage('page-chat');
});

socket.on('message_received', (data) => {
    document.getElementById('typing-indicator').style.display = 'none';
    const avatarToUse = isGroupChat ? data.avatar : partnerAvatarUrl;
    renderMessage(data.msg, 'other', data.time, avatarToUse);
    appendMsg({ text: data.msg, type: 'other', time: data.time, avatar: avatarToUse });
});

socket.on('partner_typing', (data) => {
    const el = document.getElementById('typing-indicator');
    if(el) {
        el.style.display = data.isTyping ? 'flex' : 'none';
        if(isGroupChat) el.querySelector('span').innerText = currentLang === 'zh' ? "有人正在输入..." : "Someone is typing...";
        else el.querySelector('span').innerText = window.translations[currentLang].typing;
        if(data.isTyping) scrollToBottom();
    }
});

socket.on('system_message', (text) => {
    renderMessage(text, 'system', '', '');
    appendMsg({ text: text, type: 'system', time: '', avatar: '' });
});

socket.on('match_invite', (data) => showInviteNotification(data));
socket.on('waiting_for_invite', () => {
    showPage('page-loading');
    document.getElementById('loading-text').innerHTML = `已发现潜在伙伴！<br>正在呼叫对方...<br><span style="font-size:0.8rem">(对方是历史用户，需要等待确认)</span>`;
});
socket.on('invite_timeout', () => document.getElementById('loading-text').innerHTML = `对方未响应。<br>正在重新搜索在线队列...`);
socket.on('invite_error', (msg) => { alert(msg); document.getElementById('loading-text').innerText = "继续搜索中..."; });

socket.on('partner_left', () => {
    const chatBody = document.getElementById('chatBody');
    if (chatBody.lastElementChild && chatBody.lastElementChild.innerText.includes("离开")) return;
    
    const leaveText = currentLang === 'zh' ? "对方已离开聊天室" : "Partner has left the chat";
    renderMessage(leaveText, 'system', '', '');
    appendMsg({ text: leaveText, type: 'system', time: '', avatar: '' });

    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.querySelector('.input-bar button');
    if (chatInput) { chatInput.disabled = true; chatInput.placeholder = currentLang === 'zh' ? "聊天已结束" : "Chat ended"; }
    if (sendBtn) { sendBtn.disabled = true; sendBtn.style.background = "#ccc"; }
    
    const statusEl = document.getElementById('match-status');
    if (statusEl) { statusEl.innerText = currentLang === 'zh' ? "● 已断开" : "● Disconnected"; statusEl.style.color = "#999"; }
});

// === 初始化 ===
window.onload = () => {
    const session = getSession();
    if (session) {
        enableChatInput(); 
        isGroupChat = session.isGroupChat || false;
        currentRoom = session.roomId;
        myAvatarUrl = session.myAvatar;
        partnerAvatarUrl = session.partnerAvatar;
        
        const avatarEl = document.getElementById('avatar-container');
        if (isGroupChat) {
            if(avatarEl) avatarEl.style.display = 'none';
            document.getElementById('partner-name').innerText = `💬 频道: #${session.keyword}`;
            document.getElementById('match-status').innerText = `● 群聊已恢复`;
        } else {
            if(avatarEl) avatarEl.style.display = 'block';
            document.getElementById('partner-avatar-img').src = partnerAvatarUrl;
            document.getElementById('partner-name').innerText = window.translations[currentLang].partnerName;
            document.getElementById('match-status').innerText = `● 已恢复记录`;
        }
        document.getElementById('match-status').style.color = "#22c55e";
        
        document.getElementById('chatBody').innerHTML = `<div class="msg-system-bubble">${window.translations[currentLang].matchTopic} <b>${session.keyword}</b></div>`;
        
        session.messages.forEach(msg => {
            const renderAvatar = msg.type === 'me' ? myAvatarUrl : (isGroupChat ? msg.avatar : partnerAvatarUrl);
            renderMessage(msg.text, msg.type, msg.time, renderAvatar);
        });
        
        showPage('page-chat');
        socket.emit('rejoin_room', currentRoom);
    }

    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') window.sendMsg(); });
        chatInput.addEventListener('input', () => {
            socket.emit('typing', { room: currentRoom, isTyping: true });
            clearTimeout(typingTimeout);
            typingTimeout = setTimeout(() => { socket.emit('typing', { room: currentRoom, isTyping: false }); }, 1000);
        });
    }
    updatePageText();
};