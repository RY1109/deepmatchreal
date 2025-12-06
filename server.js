// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { initAI, getVector, calculateMatch, getAIChatReply } = require('./ai-service');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));
initAI();

// 数据结构
let waitingQueue = []; 
const BOT_ROOMS = new Set();
// ✅ 新增：机器人记忆库 Key: roomID, Value: Array<Message>
const botMemory = new Map(); 

let realConnectionCount = 0;

// 伪造在线人数
function broadcastFakeStats() {
    const fakeCount = 180 + realConnectionCount + Math.floor(Math.random() * 40);
    io.emit('online_count', fakeCount);
}
setInterval(broadcastFakeStats, 5000);

// 生成随机人设
function getBotPersona(keyword) {
    const personas = [
        `你是一个搞怪的网友，正在摸鱼。话题是${keyword}。说话幽默，喜欢用表情包文字，偶尔开玩笑。不要像机器人，要像个活人。`,
        `你是一个热情的${keyword}爱好者，说话很激动，喜欢用感叹号，对这个话题非常了解。`,
        `你是一个高冷的${keyword}大神，说话简短有力，但也乐于助人。`,
        `你是一个话痨网友，特别爱聊天，喜欢反问对方问题来延续话题。话题：${keyword}。`
    ];
    // 随机选一个人设，防止所有机器人都一个味儿
    return personas[Math.floor(Math.random() * personas.length)];
}

// 启动机器人匹配
function startBotMatch(userSocket, keyword) {
    const roomID = 'bot_' + Date.now();
    userSocket.join(roomID);
    BOT_ROOMS.add(roomID);

    // ✅ 初始化记忆：给这个房间植入“人设”
    const systemPrompt = getBotPersona(keyword);
    botMemory.set(roomID, [
        { role: "system", content: systemPrompt }
    ]);

    const s1 = Math.floor(Math.random() * 1000);
    const s2 = Math.floor(Math.random() * 1000);

    userSocket.emit('match_found', {
        partnerId: 'user_bot', room: roomID, myAvatar: s1, partnerAvatar: s2,
        keyword: `${keyword}`
    });

    console.log(`🤖 AI(72B) 接管: ${userSocket.id} | 话题: ${keyword}`);

    // AI 主动打招呼
    setTimeout(async () => {
        // 构造打招呼的上下文
        const history = botMemory.get(roomID);
        // 假装用户进来了，触发 AI 打招呼
        history.push({ role: "user", content: "我进来了，哈喽" });
        
        const reply = await getAIChatReply(history);
        
        // 记录 AI 的回复
        history.push({ role: "assistant", content: reply });
        
        userSocket.emit('message_received', { 
            msg: reply, 
            time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) 
        });
    }, 1500);
}

io.on('connection', (socket) => {
    realConnectionCount++;
    broadcastFakeStats();

    socket.on('disconnect', () => {
        realConnectionCount--;
        waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
        // 如果断开的是机器人房间，清理内存，防止内存泄漏
        // (在实际生产中，这里需要更严谨的判断，这里简单处理)
        for (const room of socket.rooms) {
            if (botMemory.has(room)) botMemory.delete(room);
        }
    });

    socket.on('search_match', async (rawInput) => {
        // ... (保持原本的匹配逻辑不变，代码太长省略，请保留你之前写好的逻辑) ...
        // ... 重点是最后那个 setTimeout 里的 startBotMatch 调用 ...
        
        // 这里仅为了演示，我保留进入机器人模式的入口：
        // (请把你之前的 search_match 逻辑放这里，并在超时的时候调用 startBotMatch)
        
        // --- 临时代码：强制进 AI 方便你测试 (测试完记得改回去) ---
        const keyword = rawInput || "随便";
        startBotMatch(socket, keyword);
    });

    socket.on('chat_message', async (data) => {
        if (BOT_ROOMS.has(data.room)) {
            // === AI 房间处理逻辑 ===
            const history = botMemory.get(data.room);
            if (!history) return;

            // 1. 把用户的消息存入记忆
            history.push({ role: "user", content: data.msg });

            // 2. 限制记忆长度 (防止 token 爆炸，只记最近 10 轮对话)
            if (history.length > 20) {
                // 保留 system prompt (第0个)，删除中间旧的
                const systemMsg = history[0];
                const recentMsgs = history.slice(-10);
                botMemory.set(data.room, [systemMsg, ...recentMsgs]);
            }

            socket.emit('partner_typing', true);

            // 3. 发送完整历史给 AI
            const aiReply = await getAIChatReply(history);

            // 4. 把 AI 的回复存入记忆
            history.push({ role: "assistant", content: aiReply });

            // 5. 模拟延迟回复
            const delay = Math.max(1000, aiReply.length * 50); // 字越多打字越久
            setTimeout(() => {
                socket.emit('partner_typing', false);
                socket.emit('message_received', { 
                    msg: aiReply, 
                    time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) 
                });
            }, delay);

        } else {
            // 真人房间转发
            socket.to(data.room).emit('message_received', data);
        }
    });

    socket.on('typing', (d) => {
        if (!BOT_ROOMS.has(d.room)) socket.to(d.room).emit('partner_typing', d);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 服务器运行中 (Qwen-72B版): http://localhost:${PORT}`);
});