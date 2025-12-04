const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { initAI, getVector, calculateMatch } = require('./ai-service');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

console.log("正在初始化 AI 服务...");
initAI().then(() => console.log("AI 服务准备就绪"));

let waitingQueue = [];

// 广播排队人数
function broadcastQueueStats() {
    io.emit('online_count', waitingQueue.length);
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
    
    broadcastQueueStats(); // 更新人数
    console.log(`✅ 匹配达成: ${userA.keyword} <-> ${userB.keyword}`);
}

io.on('connection', (socket) => {
    socket.emit('online_count', waitingQueue.length);

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

        // === 1. 尝试立即精准匹配 (门槛 0.5) ===
        let bestIndex = -1;
        let maxScore = -1;

        for (let i = 0; i < waitingQueue.length; i++) {
            const waiter = waitingQueue[i];
            if (waiter.id === socket.id) continue;

            const result = calculateMatch(myKeyword, waiter.keyword, myVector, waiter.vector);
            if (result.score > maxScore && result.score >= 0.5) {
                maxScore = result.score;
                bestIndex = i;
            }
        }

        if (bestIndex !== -1) {
            const partner = waitingQueue[bestIndex];
            // 安全移除两人
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id && u.id !== partner.id);
            executeMatch(
                { id: socket.id, socket: socket, keyword: myKeyword },
                partner,
                `${myKeyword} & ${partner.keyword} (${Math.round(maxScore * 100)}%)`
            );
        } else {
            // === 2. 没匹配到，加入队列 ===
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id); // 先防重
            const myUserObj = { 
                id: socket.id, 
                keyword: myKeyword, 
                vector: myVector, 
                socket: socket,
                startTime: Date.now() 
            };
            waitingQueue.push(myUserObj);
            socket.emit('waiting_in_queue', myKeyword);
            broadcastQueueStats();
            console.log(`⏳ 入队等待 (当前队列: ${waitingQueue.length}人)`);

            // === 3. ⏰ 8秒超时强制匹配逻辑 (已修复崩溃Bug) ===
            setTimeout(() => {
                // 第一步：确保我自己还在队列里 (没掉线，也没被别人匹配走)
                const meStillHere = waitingQueue.find(u => u.id === socket.id);
                
                if (meStillHere) {
                    console.log(`⏰ [${socket.id}] 8秒超时，尝试强制匹配...`);
                    
                    // 第二步：寻找剩下的最佳人选 (排除自己)
                    let forcedBestPartner = null;
                    let forcedMaxScore = -999; 

                    for (const waiter of waitingQueue) {
                        if (waiter.id === meStillHere.id) continue; // 跳过自己

                        const result = calculateMatch(myKeyword, waiter.keyword, myVector, waiter.vector);
                        if (result.score > forcedMaxScore) {
                            forcedMaxScore = result.score;
                            forcedBestPartner = waiter;
                        }
                    }

                    // 第三步：如果有合适的人 (哪怕分数很低)
                    if (forcedBestPartner) {
                        // 🌟 核心修复：使用 filter 安全移除，不依赖索引
                        waitingQueue = waitingQueue.filter(u => u.id !== meStillHere.id && u.id !== forcedBestPartner.id);
                        
                        const percent = Math.round(forcedMaxScore * 100);
                        const matchText = percent < 40 ? 
                            `(扩大搜索) ${myKeyword} & ${forcedBestPartner.keyword}` : 
                            `${myKeyword} & ${forcedBestPartner.keyword} (${percent}%)`;

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