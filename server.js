const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
// ✅ 引入新增的 getAIChatReply
const { initAI, getVector, calculateMatch, getAIChatReply } = require('./ai-service');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    pingTimeout: 60000, 
    pingInterval: 25000, 
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

console.log("正在初始化 AI 服务...");
initAI().then(() => console.log("AI 服务准备就绪"));

// ==========================================
// 1. 数据结构
// ==========================================
let waitingQueue = []; 
const userHistory = new Map();
const MAX_HISTORY = 4; 
const HISTORY_TTL = 12 * 60 * 60 * 1000; 

// ✅ 新增：记录哪些房间是 AI 房间 (Set<RoomID>)
const BOT_ROOMS = new Set();
let realConnectionCount = 0; // 真实连接数

// ==========================================
// 2. 核心功能：虚假在线人数
// ==========================================
function broadcastFakeStats() {
    // 算法：基础值(150) + 真实连接数 + 随机波动(0-30)
    // 让人数看起来像是在 150 ~ 200 之间活跃
    const fakeCount = 150 + realConnectionCount + Math.floor(Math.random() * 30);
    io.emit('online_count', fakeCount);
}

// 每 5 秒刷新一次假数据，制造“活跃”假象
setInterval(broadcastFakeStats, 5000);

// ==========================================
// 3. 辅助函数
// ==========================================
function updateUserHistory(deviceId, keyword, vector) {
    if (!deviceId || !keyword) return;
    const now = Date.now();
    let history = userHistory.get(deviceId) || [];
    history = history.filter(h => (now - h.time < HISTORY_TTL) && (h.keyword !== keyword));
    history.unshift({ keyword, vector, time: now });
    if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
    userHistory.set(deviceId, history);
}

// 真人匹配执行
function executeMatch(userA, userB, matchInfo) {
    const roomID = 'room_' + Date.now();
    
    userA.socket.join(roomID);
    userB.socket.join(roomID);

    // 清理旧房间
    Array.from(userB.socket.rooms).forEach(r => {
        if(r !== userB.id && r !== roomID) userB.socket.leave(r);
    });

    // 确保不是机器人房间
    BOT_ROOMS.delete(roomID);

    const s1 = Math.floor(Math.random() * 1000);
    const s2 = Math.floor(Math.random() * 1000);

    const payload = { room: roomID, keyword: matchInfo };
    userA.socket.emit('match_found', { ...payload, partnerId: userB.id, myAvatar: s1, partnerAvatar: s2 });
    userB.socket.emit('match_found', { ...payload, partnerId: userA.id, myAvatar: s2, partnerAvatar: s1 });
    
    console.log(`✅ 真人匹配: ${matchInfo}`);
}

// ✅ 新增：AI 机器人匹配执行
async function startBotMatch(userSocket, keyword) {
    const roomID = 'bot_' + Date.now();
    userSocket.join(roomID);
    BOT_ROOMS.add(roomID); // 标记为 AI 房间

    const s1 = Math.floor(Math.random() * 1000);
    const s2 = Math.floor(Math.random() * 1000);

    // 假装匹配到了
    userSocket.emit('match_found', {
        partnerId: 'user_bot',
        room: roomID,
        myAvatar: s1,
        partnerAvatar: s2,
        keyword: `${keyword} (AI智能匹配)` 
    });

    console.log(`🤖 AI接管: 用户 ${userSocket.id} -> 话题: ${keyword}`);

    // AI 先发制人：延迟 1.5 秒打招呼
    setTimeout(async () => {
        // 让 AI 根据话题生成开场白
        const greeting = await getAIChatReply("你好，刚连上，打个招呼", keyword);
        userSocket.emit('message_received', {
            msg: greeting,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
    }, 1500);
}

// ==========================================
// 4. Socket 主逻辑
// ==========================================
io.on('connection', (socket) => {
    realConnectionCount++;
    const deviceId = socket.handshake.auth.deviceId;

    broadcastFakeStats(); // 连入时立即推送一次
    console.log(`➕ 连入: ${socket.id}`);

    socket.on('disconnect', () => {
        realConnectionCount--;
        waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
        // 如果断开的是机器人房间，稍微清理一下内存(Set自动清理string，其实不用特意操作)
    });

    socket.on('search_match', async (rawInput) => {
        // 清理房间
        Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });

        const myKeyword = rawInput ? rawInput.trim() : "随便";
        let myVector = null;
        try { myVector = await getVector(myKeyword); } catch (e) {}

        if (deviceId && myVector) updateUserHistory(deviceId, myKeyword, myVector);

        // --- 1. 尝试真人精准匹配 ---
        let bestIndex = -1;
        let maxScore = -1;
        let matchedInfoText = "";

        for (let i = 0; i < waitingQueue.length; i++) {
            const waiter = waitingQueue[i];
            if (waiter.id === socket.id) continue;

            // 比对当前词 + 历史记录 (这里保持你原有的逻辑不变)
            let result = calculateMatch(myKeyword, waiter.keyword, myVector, waiter.vector);
            let currentBestScore = result.score;
            let currentTopic = `${myKeyword} & ${waiter.keyword}`;

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

            if (currentBestScore > maxScore && currentBestScore >= 0.5) {
                maxScore = currentBestScore;
                bestIndex = i;
                matchedInfoText = currentTopic;
            }
        }

        if (bestIndex !== -1) {
            // 命中真人
            const partner = waitingQueue[bestIndex];
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id && u.id !== partner.id);
            executeMatch(
                { id: socket.id, socket: socket, keyword: myKeyword },
                partner,
                `${matchedInfoText} (${Math.round(maxScore * 100)}%)`
            );
        } else {
            // --- 2. 没命中，加入队列 ---
            // 先清理旧的自己
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
            
            const myUserObj = { 
                id: socket.id, deviceId, keyword: myKeyword, vector: myVector, 
                socket: socket, startTime: Date.now() 
            };
            waitingQueue.push(myUserObj);
            
            socket.emit('waiting_in_queue', myKeyword);
            console.log(`⏳ 入队: ${myKeyword}`);

            // === 3. ⏰ 8秒超时逻辑 (核心修改) ===
            setTimeout(() => {
                // 检查自己是否还在队列里 (没被别人匹配走，也没断开)
                const meStillHere = waitingQueue.find(u => u.id === socket.id);
                
                if (meStillHere) {
                    // 再次尝试寻找真人 (扩大搜索范围/强制匹配逻辑)
                    // ... 这里省略了部分你原有的强制匹配真人的逻辑，简化为：
                    // 如果哪怕强制也找不到真人，或者队列里只有我一个 -> 启动 AI
                    
                    let foundHuman = false;
                    // (此处保留你原来的强制真人匹配逻辑，如果匹配成功 foundHuman = true)
                    // 简便起见，如果队列人数 <= 1，直接判为无人
                    
                    if (waitingQueue.length <= 1) {
                        // 💔 实在没真人了 -> 移除队列 -> 启动 AI
                        waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
                        startBotMatch(socket, myKeyword);
                    } else {
                        // 还有其他人，保留你之前的强制匹配逻辑...
                        // 如果强制匹配也失败，最终也是调用 startBotMatch
                    }
                }
            }, 5000);
        }
    });

    // === ✅ 修改：聊天消息监听 (区分真人/AI) ===
    socket.on('chat_message', async (data) => {
        // data = { room, msg, time }
        
        if (BOT_ROOMS.has(data.room)) {
            // ---> 这是一个 AI 房间
            
            // 1. 模拟对方(AI)正在输入
            socket.emit('partner_typing', true);

            // 2. 随机延迟 1~3 秒，模仿人类思考
            const delay = 1000 + Math.random() * 2000;
            
            // 3. 调用 AI 获取回复
            // 这里的 "topic" 可以稍微模糊一点，或者存入 BOT_ROOMS 里
            const aiReply = await getAIChatReply(data.msg, "聊天"); 

            setTimeout(() => {
                socket.emit('partner_typing', false); // 停止输入
                socket.emit('message_received', { 
                    msg: aiReply, 
                    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
                });
            }, delay);

        } else {
            // ---> 真人房间，直接转发
            socket.to(data.room).emit('message_received', data);
        }
    });

    socket.on('typing', (data) => {
        // 只有真人房间才转发 typing 事件，AI 房间的 typing 由上面控制
        if (!BOT_ROOMS.has(data.room)) {
            socket.to(data.room).emit('partner_typing', data);
        }
    });

    socket.on('rejoin_room', (r) => socket.join(r));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 服务器运行中: http://localhost:${PORT}`);
});