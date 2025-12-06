const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { initAI, getVector, calculateMatch } = require('./ai-service');

const app = express();
const server = http.createServer(app);

// ✅ 保持你之前的 Socket 配置
const io = new Server(server, {
    pingTimeout: 60000, 
    pingInterval: 25000, 
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

console.log("正在初始化 AI 服务...");
initAI().then(() => console.log("AI 服务准备就绪"));

// ==========================================
// 1. 新增：历史记录缓存系统
// ==========================================
let waitingQueue = []; // 队列结构: { id, deviceId, keyword, vector, socket, startTime }

// 历史记录 Map: key=deviceId, value=[ { keyword, vector, time } ]
const userHistory = new Map();
const MAX_HISTORY = 4; // 保留4个
const HISTORY_TTL = 12 * 60 * 60 * 1000; // 12小时有效期

// 广播排队人数
function broadcastQueueStats() {
    io.emit('online_count', waitingQueue.length);
}

// 辅助函数：更新历史记录
function updateUserHistory(deviceId, keyword, vector) {
    if (!deviceId || !keyword) return;

    const now = Date.now();
    let history = userHistory.get(deviceId) || [];

    // 1. 过滤：移除过期记录 & 移除重复关键词
    history = history.filter(h => 
        (now - h.time < HISTORY_TTL) && (h.keyword !== keyword)
    );

    // 2. 新增：添加到队头
    history.unshift({ keyword, vector, time: now });

    // 3. 截断：只留最新4个
    if (history.length > MAX_HISTORY) {
        history = history.slice(0, MAX_HISTORY);
    }

    userHistory.set(deviceId, history);
    // console.log(`💾 [${deviceId}] 历史缓存更新:`, history.map(h => h.keyword));
}

// 公共匹配执行逻辑
function executeMatch(userA, userB, matchInfo) {
    const roomID = 'room_' + Date.now();
    
    userA.socket.join(roomID);
    userB.socket.join(roomID);

    Array.from(userB.socket.rooms).forEach(r => {
        if(r !== userB.id && r !== roomID) userB.socket.leave(r);
    });

    const s1 = Math.floor(Math.random() * 1000);
    const s2 = Math.floor(Math.random() * 1000);

    const payload = { room: roomID, keyword: matchInfo };
    
    userA.socket.emit('match_found', { ...payload, partnerId: userB.id, myAvatar: s1, partnerAvatar: s2 });
    userB.socket.emit('match_found', { ...payload, partnerId: userA.id, myAvatar: s2, partnerAvatar: s1 });
    
    broadcastQueueStats(); 
    console.log(`✅ 匹配达成: ${matchInfo}`);
}

io.on('connection', (socket) => {
    // ✅ 获取前端传来的唯一身份标识 (deviceId)
    const deviceId = socket.handshake.auth.deviceId;

    socket.emit('online_count', waitingQueue.length);
    console.log(`➕ 用户连入: ${socket.id} (设备ID: ${deviceId || '未知'})`);

    socket.on('disconnecting', () => {
        Array.from(socket.rooms).forEach(room => {
            if (room !== socket.id) socket.to(room).emit('system_message', { type: 'system', textKey: 'partnerLeft' });
        });
    });

    socket.on('disconnect', () => {
        const prevLen = waitingQueue.length;
        waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
        if (waitingQueue.length !== prevLen) broadcastQueueStats();
    });

    socket.on('search_match', async (rawInput) => {
        // 清理旧房间
        Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });

        const myKeyword = rawInput ? rawInput.trim() : "随便";
        console.log(`🔍 [${socket.id}] 请求匹配: "${myKeyword}"`);

        let myVector = null;
        try { myVector = await getVector(myKeyword); } catch (e) { console.error(e.message); }

        // ✅ 关键点：匹配前，先把这次搜索存入该设备的历史记录
        if (deviceId && myVector) {
            updateUserHistory(deviceId, myKeyword, myVector);
        }

        // === 1. 尝试立即精准匹配 (门槛 0.5) ===
        let bestIndex = -1;
        let maxScore = -1;
        let matchedInfoText = ""; // 记录最终是因为哪个词匹配上的

        for (let i = 0; i < waitingQueue.length; i++) {
            const waiter = waitingQueue[i];
            if (waiter.id === socket.id) continue;

            // --- A. 比对当前词 ---
            let result = calculateMatch(myKeyword, waiter.keyword, myVector, waiter.vector);
            let currentBestScore = result.score;
            let currentTopic = `${myKeyword} & ${waiter.keyword}`;

            // --- B. 比对 waiter 的历史记录 (挖坟模式) ---
            // 如果对方有 DeviceID 且有历史记录，并且当前词匹配度不高
            if (currentBestScore < 0.5 && waiter.deviceId && userHistory.has(waiter.deviceId)) {
                const historyList = userHistory.get(waiter.deviceId);
                
                for (const hItem of historyList) {
                    // 跳过对方当前正在搜的词(已经比过了)
                    if (hItem.keyword === waiter.keyword) continue;

                    const hResult = calculateMatch(myKeyword, hItem.keyword, myVector, hItem.vector);
                    
                    // 如果发现历史记录里有更匹配的
                    if (hResult.score > currentBestScore) {
                        currentBestScore = hResult.score;
                        currentTopic = `${myKeyword} & ${hItem.keyword} (历史)`;
                    }
                }
            }

            // 更新全局最佳
            if (currentBestScore > maxScore && currentBestScore >= 0.5) {
                maxScore = currentBestScore;
                bestIndex = i;
                matchedInfoText = currentTopic;
            }
        }

        if (bestIndex !== -1) {
            // ---> 精准匹配成功
            const partner = waitingQueue[bestIndex];
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id && u.id !== partner.id);
            executeMatch(
                { id: socket.id, socket: socket, keyword: myKeyword },
                partner,
                `${matchedInfoText} (${Math.round(maxScore * 100)}%)`
            );
        } else {
            // === 2. 没匹配到，加入队列 ===
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
            
            const myUserObj = { 
                id: socket.id, 
                deviceId: deviceId, // ✅ 存入 deviceId 供后续匹配查阅
                keyword: myKeyword, 
                vector: myVector, 
                socket: socket,
                startTime: Date.now() 
            };
            waitingQueue.push(myUserObj);
            
            socket.emit('waiting_in_queue', myKeyword);
            broadcastQueueStats();
            console.log(`⏳ 入队等待 (当前队列: ${waitingQueue.length}人)`);

            // === 3. ⏰ 8秒超时强制匹配逻辑 ===
            setTimeout(() => {
                const meStillHere = waitingQueue.find(u => u.id === socket.id);
                
                if (meStillHere) {
                    console.log(`⏰ [${socket.id}] 8秒超时，尝试强制匹配...`);
                    
                    let forcedBestPartner = null;
                    let forcedMaxScore = -999; 
                    let forcedInfoText = "";

                    for (const waiter of waitingQueue) {
                        if (waiter.id === meStillHere.id) continue;

                        // 超时也同样应用历史记录逻辑，尽最大努力找个稍微靠谱点的
                        let result = calculateMatch(myKeyword, waiter.keyword, myVector, waiter.vector);
                        let currentBestScore = result.score;
                        let currentTopic = `${myKeyword} & ${waiter.keyword}`;

                        // 查历史
                        if (waiter.deviceId && userHistory.has(waiter.deviceId)) {
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

                        if (currentBestScore > forcedMaxScore) {
                            forcedMaxScore = currentBestScore;
                            forcedBestPartner = waiter;
                            forcedInfoText = currentTopic;
                        }
                    }

                    if (forcedBestPartner) {
                        // 使用 filter 安全移除
                        waitingQueue = waitingQueue.filter(u => u.id !== meStillHere.id && u.id !== forcedBestPartner.id);
                        
                        const percent = Math.round(forcedMaxScore * 100);
                        const matchText = percent < 40 ? 
                            `(扩大搜索) ${forcedInfoText}` : 
                            `${forcedInfoText} (${percent}%)`;

                        executeMatch(meStillHere, forcedBestPartner, matchText);
                    } else {
                        console.log(`💔 队列里只有我自己，继续等待...`);
                    }
                }
            }, 8000);
        }
    });

    socket.on('chat_message', (d) => socket.to(d.room).emit('message_received', d));
    socket.on('typing', (d) => socket.to(d.room).emit('partner_typing', d));
    socket.on('rejoin_room', (r) => socket.join(r));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 服务器运行中: http://localhost:${PORT}`);
});