const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
// 引入 ai-service，但在配置关闭时不调用它
const { initAI, getVector, calculateMatch, getAIChatReply } = require('./ai-service');

// ===============================================================
// 🎛️ 全局功能开关 (修改这里即可控制功能)
// ===============================================================
const CONFIG = {
    // 🔴 1. AI 聊天/陪聊机器人：设为 false 则彻底关闭，没人时一直排队
    ENABLE_AI_BOT: false,

    // 🟢 2. AI 向量匹配：设为 false 则只用关键词字面匹配 (省流、极速)
    ENABLE_VECTOR_MATCH: true,

    // 🔴 3. 虚假在线人数：设为 true 则显示 100+ 在线，false 显示真实人数
    FAKE_ONLINE_COUNT: false
};
// ===============================================================

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    pingTimeout: 60000, 
    pingInterval: 25000, 
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

// 只有在开启任意 AI 功能时才初始化
if (CONFIG.ENABLE_AI_BOT || CONFIG.ENABLE_VECTOR_MATCH) {
    console.log("正在初始化 AI 服务...");
    initAI().catch(e => console.error("AI 初始化失败(不影响主流程):", e));
} else {
    console.log("🔕 AI 功能已全部关闭，系统运行在【纯净模式】");
}

// -----------------------------------------------------------

let waitingQueue = []; 
const userHistory = new Map();
const MAX_HISTORY = 4; 
const HISTORY_TTL = 12 * 60 * 60 * 1000; 

// 机器人房间记录
const BOT_ROOMS = new Set();
let realConnectionCount = 0; 

// === 1. 广播在线人数 (含造假逻辑) ===
function broadcastStats() {
    let count = realConnectionCount;
    
    if (CONFIG.FAKE_ONLINE_COUNT) {
        // 基础 150 + 真实 + 随机波动 (让数字看起来是活的)
        count = 150 + realConnectionCount + Math.floor(Math.random() * 35);
    }
    
    io.emit('online_count', count);
}
// 每 5 秒刷新一次
setInterval(broadcastStats, 5000);

// === 2. 辅助函数 ===
function updateUserHistory(deviceId, keyword, vector) {
    if (!deviceId || !keyword) return;
    const now = Date.now();
    let history = userHistory.get(deviceId) || [];
    history = history.filter(h => (now - h.time < HISTORY_TTL) && (h.keyword !== keyword));
    history.unshift({ keyword, vector, time: now });
    if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
    userHistory.set(deviceId, history);
}

function executeMatch(userA, userB, matchInfo) {
    const roomID = 'room_' + Date.now();
    
    userA.socket.join(roomID);
    userB.socket.join(roomID);

    // 清理旧房间
    [userA, userB].forEach(u => {
        Array.from(u.socket.rooms).forEach(r => {
            if(r !== u.id && r !== roomID) u.socket.leave(r);
        });
    });

    BOT_ROOMS.delete(roomID);

    const s1 = Math.floor(Math.random() * 1000);
    const s2 = Math.floor(Math.random() * 1000);

    const payload = { room: roomID, keyword: matchInfo };
    userA.socket.emit('match_found', { ...payload, partnerId: userB.id, myAvatar: s1, partnerAvatar: s2 });
    userB.socket.emit('match_found', { ...payload, partnerId: userA.id, myAvatar: s2, partnerAvatar: s1 });
    
    console.log(`✅ 真人匹配成功: ${matchInfo}`);
}

// 机器人匹配 (只有开关开启时才会被调用)
async function startBotMatch(userSocket, keyword) {
    const roomID = 'bot_' + Date.now();
    userSocket.join(roomID);
    BOT_ROOMS.add(roomID);

    const s1 = Math.floor(Math.random() * 1000);
    const s2 = Math.floor(Math.random() * 1000);

    userSocket.emit('match_found', {
        partnerId: 'user_bot',
        room: roomID,
        myAvatar: s1,
        partnerAvatar: s2,
        keyword: `${keyword} (AI智能匹配)` 
    });

    // AI 打招呼
    setTimeout(async () => {
        let greeting = "你好呀，刚连上~";
        try {
            greeting = await getAIChatReply([{ role: "user", content: "打个招呼" }]);
        } catch (e) {}
        
        userSocket.emit('message_received', {
            msg: greeting,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
    }, 1500);
}

// ==========================================
// Socket 主逻辑
// ==========================================
io.on('connection', (socket) => {
    realConnectionCount++;
    const deviceId = socket.handshake.auth.deviceId;
    
    // 连入立即推送一次人数
    broadcastStats(); 
    console.log(`➕ 连入: ${socket.id}`);

    socket.on('disconnect', () => {
        realConnectionCount--;
        waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
    });

    socket.on('search_match', async (rawInput) => {
        // 离开旧房间
        Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });

        const myKeyword = rawInput ? rawInput.trim() : "随便";
        let myVector = null;

        // 🟢 只有开启向量开关时，才去调用 API
        if (CONFIG.ENABLE_VECTOR_MATCH) {
            try { myVector = await getVector(myKeyword); } catch (e) {}
        }

        if (deviceId) updateUserHistory(deviceId, myKeyword, myVector);

        // --- 匹配核心逻辑 ---
        let bestIndex = -1;
        let maxScore = -1;
        let matchedInfoText = "";

        for (let i = 0; i < waitingQueue.length; i++) {
            const waiter = waitingQueue[i];
            if (waiter.id === socket.id) continue;

            // 调用 calculateMatch (如果你关了向量，它会自动只对比文本)
            let result = calculateMatch(myKeyword, waiter.keyword, myVector, waiter.vector);
            let currentBestScore = result.score;
            let currentTopic = `${myKeyword} & ${waiter.keyword}`;

            // 历史记录逻辑
            if (currentBestScore < 0.5 && waiter.deviceId && userHistory.has(waiter.deviceId)) {
                const historyList = userHistory.get(waiter.deviceId);
                for (const hItem of historyList) {
                    if (hItem.keyword === waiter.keyword) continue;
                    const hResult = calculateMatch(myKeyword, hItem.keyword, myVector, hItem.vector);
                    if (hResult.score > currentBestScore) {
                        currentBestScore = hResult.score;
                        currentTopic = `${myKeyword} & ${hItem.keyword} (历史)`;
                    }
                }
            }

            // 更新最佳匹配对象
            if (currentBestScore > maxScore && currentBestScore >= 0.5) {
                maxScore = currentBestScore;
                bestIndex = i;
                matchedInfoText = currentTopic;
            }
        }

        // === 判定匹配结果 ===
        if (bestIndex !== -1) {
            // ✅ 匹配成功：从队列移除双方并开始聊天
            const partner = waitingQueue[bestIndex];
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id && u.id !== partner.id);
            
            executeMatch(
                { id: socket.id, socket: socket, keyword: myKeyword },
                partner,
                `${matchedInfoText}`
            );
        } else {
            // ⏳ 没匹配到：加入等待队列
            
            // 先清理旧的自己（防止重复入队）
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
            
            waitingQueue.push({ 
                id: socket.id, deviceId, keyword: myKeyword, vector: myVector, 
                socket: socket, startTime: Date.now() 
            });
            
            socket.emit('waiting_in_queue', myKeyword);
            console.log(`⏳ 入队等待: ${myKeyword}`);

            // === 超时检查逻辑 ===
            // 8秒后如果还在队列里，根据配置决定是否派机器人
            setTimeout(() => {
                const meStillHere = waitingQueue.find(u => u.id === socket.id);
                
                // 只有当 (1)人还在 (2)开启了AI机器人开关 时，才触发机器人
                if (meStillHere && CONFIG.ENABLE_AI_BOT) {
                    waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
                    startBotMatch(socket, myKeyword);
                } 
                // 如果 CONFIG.ENABLE_AI_BOT 为 false，用户就会一直留在队列里等待真人
            }, 8000);
        }
    });

    // === 聊天消息转发 ===
    socket.on('chat_message', async (data) => {
        // 判断是不是机器人房间
        if (BOT_ROOMS.has(data.room)) {
            // 🟢 AI 开启状态下，生成回复
            if (CONFIG.ENABLE_AI_BOT) {
                socket.emit('partner_typing', true);
                
                // 模拟延迟
                setTimeout(async () => {
                    let aiReply = "哈哈";
                    try {
                        // 简单的上下文构造
                        aiReply = await getAIChatReply([{ role: "user", content: data.msg }]);
                    } catch (e) {
                        aiReply = "（网络波动...）";
                    }

                    socket.emit('partner_typing', false);
                    socket.emit('message_received', { 
                        msg: aiReply, 
                        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
                    });
                }, 1500);
            } else {
                // 如果中途把 AI 关了
                socket.emit('message_received', { msg: "(系统: AI陪聊服务已暂停)", time: "System" });
            }
        } else {
            // 🟢 真人房间，直接转发给对方
            socket.to(data.room).emit('message_received', data);
        }
    });

    socket.on('typing', (d) => {
        if (!BOT_ROOMS.has(d.room)) {
            socket.to(d.room).emit('partner_typing', d);
        }
    });

    socket.on('rejoin_room', (r) => socket.join(r));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 服务器运行中: http://localhost:${PORT}`);
    console.log(`📋 当前配置: AI机器人[${CONFIG.ENABLE_AI_BOT ? '开' : '关'}] | 向量匹配[${CONFIG.ENABLE_VECTOR_MATCH ? '开' : '关'}] | 假人数[${CONFIG.FAKE_ONLINE_COUNT ? '开' : '关'}]`);
});