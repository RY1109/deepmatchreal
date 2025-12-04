// public/js/app.js
console.log("App.js 成功加载了！");
const socket = io();
let currentRoom = null;
let currentLang = 'zh';
let myAvatarUrl = '', partnerAvatarUrl = '';
let typingTimeout = null;

const STORAGE_KEY = 'deepmatch_session';
const getAvatar = (seed) => `https://api.dicebear.com/9.x/notionists/svg?seed=${seed}&backgroundColor=e6f7ff,ffe4e4,e6ffe6`;

// === 本地存储逻辑 ===
function saveSession(data) { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
function getSession() { const d = localStorage.getItem(STORAGE_KEY); return d ? JSON.parse(d) : null; }
function clearSession() { localStorage.removeItem(STORAGE_KEY); location.reload(); }
function appendMsg(msg) {
    const s = getSession();
    if (s) { s.messages.push(msg); saveSession(s); }
}

// === 界面操作 ===
// public/js/app.js

function showPage(id) {
    // 1. 切换页面显示
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');

    // 2. ✅ 新增逻辑：控制顶部工具栏的显示/隐藏
    const toolbar = document.getElementById('topToolbar');
    if (id === 'page-chat') {
        // 进聊天室了，隐藏右上角的语言切换，防止挡住退出按钮
        toolbar.classList.add('hidden');
    } else {
        // 回到首页或加载页，显示工具栏
        toolbar.classList.remove('hidden');
    }
}

function updatePageText() {
    const t = translations[currentLang];
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (t[key]) el.innerText = t[key];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (t[key]) el.placeholder = t[key];
    });
}

function toggleLanguage() {
    currentLang = currentLang === 'zh' ? 'en' : 'zh';
    document.getElementById('current-lang-text').innerText = currentLang === 'zh' ? 'EN' : '中';
    updatePageText();
}

function scrollToBottom() {
    const el = document.getElementById('chatBody');
    el.scrollTop = el.scrollHeight;
}

// 修改 renderMessage 函数
function renderMessage(text, type, time, avatarUrl) {
    const chatBody = document.getElementById('chatBody');
    const row = document.createElement('div');
    
    // 给 row 加上 type 类名 (me, other, 或者 system)
    row.className = `msg-row ${type}`;
    
    if (type === 'system') {
        // ✅ 系统消息特殊结构 (居中灰色文字)
        row.innerHTML = `
            <div class="msg-system-bubble">${text}</div>
        `;
    } else {
        // 普通消息结构 (保持不变)
        row.innerHTML = `
            <div class="avatar">
                <img src="${avatarUrl}" alt="User Avatar">
            </div>
            <div class="msg-content">
                <div class="bubble">${text}</div>
                <span class="time-stamp">${time}</span>
            </div>
        `;
    }
    
    chatBody.appendChild(row);
    scrollToBottom();
}

// === 核心业务 ===
function startMatching() {
    const input = document.getElementById('userInput').value.trim();
    showPage('page-loading');
    const t = translations[currentLang];
    const topic = input ? `"${input}"` : (currentLang === 'zh' ? "随机" : "Random");
    document.getElementById('loading-text').innerHTML = `${t.loadingPrefix} <b>${topic}</b> ${t.loadingSuffix}`;
    socket.emit('search_match', input);
}

function sendMsg() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    renderMessage(text, 'me', time, myAvatarUrl);
    appendMsg({ text, type: 'me', time });
    socket.emit('chat_message', { room: currentRoom, msg: text, time });
    input.value = '';
}

// === Socket 监听 ===
socket.on('online_count', (c) => document.getElementById('online-count').innerText = c);
socket.on('connect', () => document.getElementById('offline-tip').style.display = 'none');
socket.on('disconnect', () => document.getElementById('offline-tip').style.display = 'block');

socket.on('match_found', (data) => {
    currentRoom = data.room;
    myAvatarUrl = getAvatar(data.myAvatar);
    partnerAvatarUrl = getAvatar(data.partnerAvatar);
    
    // 初始化存储
    saveSession({ roomId: data.room, myAvatar: myAvatarUrl, partnerAvatar: partnerAvatarUrl, keyword: data.keyword, messages: [] });

    document.getElementById('partner-avatar-img').src = partnerAvatarUrl;
    document.getElementById('match-status').innerText = translations[currentLang].matchSuccess;
    document.getElementById('chatBody').innerHTML = `<div style="text-align: center; font-size: 0.8rem; color: #ccc; margin: 10px 0;">${translations[currentLang].matchTopic} <b>${data.keyword}</b></div>`;
    showPage('page-chat');
});

socket.on('system_message', (data) => {
    // 根据当前语言获取文本
    const t = window.translations[currentLang];
    const text = t[data.textKey] || "系统消息";
    
    // 渲染一条系统样式的消息
    renderMessage(text, 'system', '', '');
    
    // 可选：存入历史记录
    appendMsg({ text: text, type: 'system', time: '' });
});

socket.on('message_received', (data) => {
    document.getElementById('typing-indicator').style.display = 'none';
    renderMessage(data.msg, 'other', data.time, partnerAvatarUrl);
    appendMsg({ text: data.msg, type: 'other', time: data.time });
});

socket.on('partner_typing', (isTyping) => {
    const el = document.getElementById('typing-indicator');
    el.style.display = isTyping ? 'flex' : 'none';
    if(isTyping) scrollToBottom();
});

// === 初始化 ===
window.onload = () => {
    // 恢复会话
    const session = getSession();
    if (session) {
        currentRoom = session.roomId;
        myAvatarUrl = session.myAvatar;
        partnerAvatarUrl = session.partnerAvatar;
        document.getElementById('partner-avatar-img').src = partnerAvatarUrl;
        
        document.getElementById('chatBody').innerHTML = `<div style="text-align: center; font-size: 0.8rem; color: #ccc; margin: 10px 0;">${translations[currentLang].matchTopic} <b>${session.keyword}</b></div>`;
        session.messages.forEach(msg => renderMessage(msg.text, msg.type, msg.time, msg.type === 'me' ? myAvatarUrl : partnerAvatarUrl));
        
        showPage('page-chat');
        socket.emit('rejoin_room', currentRoom);
    }

    // 绑定事件
    document.getElementById('chatInput').addEventListener('input', () => {
        socket.emit('typing', { room: currentRoom, isTyping: true });
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => { socket.emit('typing', { room: currentRoom, isTyping: false }); }, 1000);
    });
    document.getElementById('chatInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMsg(); });
};