// public/js/app.js

// ==========================================
// 1. 初始化设备 ID 和 Socket 连接
// ==========================================
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

// ==========================================
// 2. 全局变量与配置
// ==========================================
let currentRoom = null;
let currentLang = 'zh';
let myAvatarUrl = '', partnerAvatarUrl = '';
let typingTimeout = null;
const STORAGE_KEY = 'deepmatch_session';

// DiceBear 头像生成
const getAvatar = (seed) => `https://api.dicebear.com/9.x/notionists/svg?seed=${seed}&backgroundColor=e6f7ff,ffe4e4,e6ffe6`;

// ==========================================
// 3. 本地存储管理
// ==========================================
function saveSession(data) { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
function getSession() { const d = localStorage.getItem(STORAGE_KEY); return d ? JSON.parse(d) : null; }
function appendMsg(msg) { const s = getSession(); if (s) { s.messages.push(msg); saveSession(s); } }

// 🔴 必须挂载到 window，否则 HTML 按钮无法调用
window.clearSession = function() { 
    localStorage.removeItem(STORAGE_KEY); 
    location.reload(); 
};

window.toggleLanguage = function() {
    currentLang = currentLang === 'zh' ? 'en' : 'zh';
    document.getElementById('current-lang-text').innerText = currentLang === 'zh' ? 'EN' : '中';
    updatePageText();
};

// ==========================================
// 4. UI 界面操作
// ==========================================
function showPage(id) {
    // 切换页面
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');

    // 控制顶部工具栏 (如果 HTML 里有这个 ID 的话)
    const toolbar = document.getElementById('topToolbar');
    if (toolbar) {
        if (id === 'page-chat') {
            toolbar.style.display = 'none'; // 进聊天室隐藏语言切换
        } else {
            toolbar.style.display = 'flex'; // 其他页面显示
        }
    }
}

function updatePageText() {
    const t = window.translations[currentLang]; // 确保 i18n.js 已加载
    if (!t) return;
    
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (t[key]) el.innerText = t[key];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (t[key]) el.placeholder = t[key];
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
        // 系统消息样式
        row.innerHTML = `<div class="msg-system-bubble">${text}</div>`;
        row.style.justifyContent = 'center'; // 强制居中
    } else {
        // 普通消息样式
        let avatarHtml = type === 'other' ? `<div class="avatar"><img src="${avatarUrl}"></div>` : '';
        row.innerHTML = `
            ${avatarHtml}
            <div>
                <div class="msg-bubble">${text}</div>
                <span class="msg-time">${time}</span>
            </div>
        `;
    }
    
    chatBody.appendChild(row);
    scrollToBottom();
}
// ==========================================
// 8. 补全：通知卡片 UI 逻辑
// ==========================================
function showInviteNotification(data) {
    const container = document.getElementById('notification-area');
    if (!container) {
        console.error("❌ HTML 中缺少 id='notification-area' 的容器！");
        return;
    }

    const card = document.createElement('div');
    card.className = 'invite-card';
    
    // 内容
    card.innerHTML = `
        <div class="title">👋 发现共同话题</div>
        <div class="info">有人正在聊 <b>${data.topic}</b>，是否加入？</div>
        <div class="invite-actions">
            <button class="btn-accept">立即加入</button>
            <button class="btn-decline">忽略</button>
        </div>
    `;

    // 绑定事件
    const btnAccept = card.querySelector('.btn-accept');
    const btnDecline = card.querySelector('.btn-decline');

    // 接受
    btnAccept.onclick = () => {
        socket.emit('accept_invite', { inviterId: data.inviterId });
        closeCard();
        // 视觉反馈
        showPage('page-loading');
        const loadingText = document.getElementById('loading-text');
        if (loadingText) loadingText.innerText = "正在连接对方...";
    };

    // 拒绝
    btnDecline.onclick = () => {
        socket.emit('decline_invite', { inviterId: data.inviterId });
        closeCard();
    };

    function closeCard() {
        // 添加退出动画（需要在 CSS 定义 fadeOutRight，如果没有定义直接 remove 也可以）
        card.style.transition = 'opacity 0.3s, transform 0.3s';
        card.style.opacity = '0';
        card.style.transform = 'translateX(100%)';
        setTimeout(() => card.remove(), 300);
    }

    // 15秒后自动关闭
    setTimeout(() => { 
        if(document.body.contains(card)) closeCard(); 
    }, 15000);

    container.appendChild(card);
}

// ✅ 关键：挂载到 window，这样你在控制台输入 showInviteNotification 也能测试了
window.showInviteNotification = showInviteNotification;

// ==========================================
// 5. 核心业务逻辑 (挂载到 window)
// ==========================================
window.startMatching = function() {
    const input = document.getElementById('userInput').value.trim();
    showPage('page-loading');
    
    const t = window.translations[currentLang];
    const topic = input ? `"${input}"` : (currentLang === 'zh' ? "随机" : "Random");
    
    // 确保 loading-text 元素存在
    const loadingText = document.getElementById('loading-text');
    if (loadingText) {
        loadingText.innerHTML = `${t.loadingPrefix} <b>${topic}</b> ${t.loadingSuffix}`;
    }
    
    socket.emit('search_match', input);
};

window.sendMsg = function() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    renderMessage(text, 'me', time, myAvatarUrl);
    appendMsg({ text, type: 'me', time });
    
    socket.emit('chat_message', { room: currentRoom, msg: text, time });
    input.value = '';
};

// ==========================================
// 6. Socket 事件监听
// ==========================================

// 连接状态
socket.on('connect', () => {
    const tip = document.getElementById('offline-tip');
    if (tip) tip.style.display = 'none';
    if (currentRoom) socket.emit('rejoin_room', currentRoom);
});

socket.on('disconnect', () => {
    const tip = document.getElementById('offline-tip');
    if (tip) tip.style.display = 'block';
});

socket.on('online_count', (c) => {
    const el = document.getElementById('online-count');
    if(el) el.innerText = c;
});

// 匹配成功
socket.on('match_found', (data) => {
    currentRoom = data.room;
    myAvatarUrl = getAvatar(data.myAvatar);
    partnerAvatarUrl = getAvatar(data.partnerAvatar);
    
    saveSession({ 
        roomId: data.room, 
        myAvatar: myAvatarUrl, 
        partnerAvatar: partnerAvatarUrl, 
        keyword: data.keyword, 
        messages: [] 
    });

    document.getElementById('partner-avatar-img').src = partnerAvatarUrl;
    
    const t = window.translations[currentLang];
    document.getElementById('match-status').innerText = t.matchSuccess;
    
    // 清空并显示欢迎语
    document.getElementById('chatBody').innerHTML = `
        <div style="text-align: center; font-size: 0.8rem; color: #ccc; margin: 10px 0;">
            ${t.matchTopic} <b>${data.keyword}</b>
        </div>
    `;
    
    showPage('page-chat');
});

// 收到消息
socket.on('message_received', (data) => {
    document.getElementById('typing-indicator').style.display = 'none';
    renderMessage(data.msg, 'other', data.time, partnerAvatarUrl);
    appendMsg({ text: data.msg, type: 'other', time: data.time });
});

// 对方正在输入
socket.on('partner_typing', (isTyping) => {
    const el = document.getElementById('typing-indicator');
    if(el) {
        el.style.display = isTyping ? 'flex' : 'none';
        if(isTyping) scrollToBottom();
    }
});

// 系统消息
socket.on('system_message', (data) => {
    // data 可以是纯字符串，也可以是 { textKey: 'xxx' } 用于多语言
    let text = typeof data === 'string' ? data : data.text;
    
    if (data.textKey && window.translations) {
        text = window.translations[currentLang][data.textKey] || text;
    }
    
    renderMessage(text, 'system', '', '');
    appendMsg({ text: text, type: 'system', time: '' });
});

// --- 邀请机制相关 ---

// 收到邀请 (被动方)
socket.on('match_invite', (data) => {
    // 使用 confirm 简单弹窗 (如果之前做了 Notification UI，请替换为 showInviteNotification)
    const accept = confirm(`🔔 叮！\n有人想聊关于 "${data.topic}" 的话题。\n\n是否立即加入？`);
    
    if (accept) {
        socket.emit('accept_invite', { inviterId: data.inviterId });
        showPage('page-loading'); 
        document.getElementById('loading-text').innerText = "正在建立连接...";
    } else {
        socket.emit('decline_invite', { inviterId: data.inviterId });
    }
});

// 等待邀请 (发起方)
socket.on('waiting_for_invite', () => {
    showPage('page-loading');
    document.getElementById('loading-text').innerHTML = 
        `已发现潜在伙伴！<br>正在呼叫对方...<br><span style="font-size:0.8rem">(对方是历史用户，需要等待确认)</span>`;
});

// 邀请超时/失效
socket.on('invite_timeout', () => {
    document.getElementById('loading-text').innerHTML = `对方未响应。<br>正在重新搜索在线队列...`;
});
socket.on('invite_error', (msg) => {
    alert(msg);
    // 保持在 loading 页面，等待下一次自动匹配
    document.getElementById('loading-text').innerText = "继续搜索中...";
});

// ==========================================
// 7. 页面加载初始化
// ==========================================
window.onload = () => {
    console.log("App.js Loaded.");
    
    // 恢复会话
    const session = getSession();
    if (session) {
        currentRoom = session.roomId;
        myAvatarUrl = session.myAvatar;
        partnerAvatarUrl = session.partnerAvatar;
        
        document.getElementById('partner-avatar-img').src = partnerAvatarUrl;
        
        const t = window.translations[currentLang];
        document.getElementById('chatBody').innerHTML = `
            <div style="text-align: center; font-size: 0.8rem; color: #ccc; margin: 10px 0;">
                ${t.matchTopic} <b>${session.keyword}</b>
            </div>
        `;
        
        session.messages.forEach(msg => {
            renderMessage(msg.text, msg.type, msg.time, msg.type === 'me' ? myAvatarUrl : partnerAvatarUrl);
        });
        
        showPage('page-chat');
        socket.emit('rejoin_room', currentRoom);
    }

    // 绑定输入框事件
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') window.sendMsg(); });
        chatInput.addEventListener('input', () => {
            socket.emit('typing', { room: currentRoom, isTyping: true });
            clearTimeout(typingTimeout);
            typingTimeout = setTimeout(() => { socket.emit('typing', { room: currentRoom, isTyping: false }); }, 1000);
        });
    }
    
    // 初始化翻译文字
    updatePageText();
};