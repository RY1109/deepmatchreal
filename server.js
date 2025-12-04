// server.js
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
// 队列结构: { id, keyword, vector, socket } 
// 注意：这次我们在队列里多存一个 socket 对象引用，方便超时逻辑使用

// === 1. 提取公共匹配逻辑 (避免代码重复) ===
function executeMatch(userA, userB, matchInfo) {
    const roomID = 'room_' + Date.now();
    
    // 双方加入房间
    userA.socket.join(roomID);
    userB.socket.join(roomID);

    // 强制对方清理其他房间
    Array.from(userB.socket.rooms).forEach(r => {
        if(r !== userB.id && r !== roomID) userB.socket.leave(r);
    });

    const s1 = Math.floor(Math.random() * 1000);
    const s2 = Math.floor(Math.random() * 1000);

    const payload = { room: roomID, keyword: matchInfo };
    
    userA.socket.emit('match_found', { ...payload, partnerId: userB.id, myAvatar: s1, partnerAvatar: s2 });
    userB.socket.emit('match_found', { ...payload, partnerId: userA.id, myAvatar: s2, partnerAvatar: s1 });
    
    console.log(`✅ 匹配达成: ${userA.keyword} <-> ${userB.keyword} | ${matchInfo}`);
}

io.on('connection', (socket) => {
    // 发送在线人数
    io.emit('online_count', io.engine.clientsCount);
    console.log(`➕ 用户连入: ${socket.id}`);

    // 断线或刷新时的清理
    socket.on('disconnecting', () => {
        Array.from(socket.rooms).forEach(room => {
            if (room !== socket.id) socket.to(room).emit('system_message', { type: 'system', textKey: 'partnerLeft' });
        });
    });

    socket.on('disconnect', () => {
        io.emit('online_count', io.engine.clientsCount);
        // 从队列移除
        waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
    });

    // === 核心匹配逻辑 ===
    socket.on('search_match', async (rawInput) => {
        // 1. 清理旧房间
        Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });

        const myKeyword = rawInput ? rawInput.trim() : "随便";
        console.log(`🔍 [${socket.id}] 请求匹配: "${myKeyword}"`);

        // 2. 获取向量
        let myVector = null;
        try { myVector = await getVector(myKeyword); } catch (e) { console.error(e.message); }

        // 3. 尝试【即时匹配】(高门槛 0.5)
        let bestIndex = -1;
        let maxScore = -1;

        for (let i = 0; i < waitingQueue.length; i++) {
            const waiter = waitingQueue[i];
            if (waiter.id === socket.id) continue;

            const result = calculateMatch(myKeyword, waiter.keyword, myVector, waiter.vector);
            if (result.score > maxScore && result.score >= 0.5) { // 严格门槛
                maxScore = result.score;
                bestIndex = i;
            }
        }

        if (bestIndex !== -1) {
            // ---> 即时匹配成功
            const partner = waitingQueue[bestIndex];
            waitingQueue.splice(bestIndex, 1); // 移除队友
            
            const percent = Math.round(maxScore * 100);
            executeMatch(
                { id: socket.id, socket: socket, keyword: myKeyword },
                partner,
                `${myKeyword} & ${partner.keyword} (契合度:${percent}%)`
            );

        } else {
            // ---> 没匹配到，加入队列
            // 先清理旧的自己
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
            
            // 存入队列 (注意：把 socket 对象也存进去)
            waitingQueue.push({ 
                id: socket.id, 
                keyword: myKeyword, 
                vector: myVector, 
                socket: socket,
                startTime: Date.now() 
            });
            
            socket.emit('waiting_in_queue', myKeyword);
            console.log(`⏳ 加入队列等待... (当前人数: ${waitingQueue.length})`);

            // ===============================================
            // ⏰ 启动 8秒 超时强制匹配机制
            // ===============================================
            setTimeout(() => {
                // 1. 检查自己是否还在队列里 (可能这8秒内已经被别人匹配走了，或者断开了)
                const myCurrentIndex = waitingQueue.findIndex(u => u.id === socket.id);
                
                if (myCurrentIndex !== -1) {
                    console.log(`⏰ [${socket.id}] 8秒超时，尝试强制匹配...`);
                    
                    // 2. 再次遍历队列，寻找剩下的“最佳人选” (无视 0.5 门槛)
                    let forcedBestIndex = -1;
                    let forcedMaxScore = -1; // 哪怕是 0 分也匹配

                    for (let i = 0; i < waitingQueue.length; i++) {
                        if (i === myCurrentIndex) continue; // 跳过自己
                        
                        const waiter = waitingQueue[i];
                        const result = calculateMatch(myKeyword, waiter.keyword, myVector, waiter.vector);
                        
                        // 只要比 -1 大就行 (找分最高的)
                        if (result.score > forcedMaxScore) {
                            forcedMaxScore = result.score;
                            forcedBestIndex = i;
                        }
                    }

                    if (forcedBestIndex !== -1) {
                        // 3. 强制匹配成功！
                        // 先把自己移除
                        waitingQueue.splice(myCurrentIndex, 1);
                        
                        // 再移除那个倒霉蛋 (注意索引可能变化，重新找 ID 安全点)
                        const partnerRecord = waitingQueue[forcedBestIndex];
                        // 但因为 splice 改变了数组，刚才算出的 forcedBestIndex 可能不准了
                        // 最稳妥的方法：根据 ID 找
                        const realPartnerIndex = waitingQueue.findIndex(u => u.id === partnerRecord.id);
                        if (realPartnerIndex !== -1) {
                            waitingQueue.splice(realPartnerIndex, 1);
                            
                            const percent = Math.round(forcedMaxScore * 100);
                            const matchText = percent < 30 ? 
                                `(扩大搜索) ${myKeyword} & ${partnerRecord.keyword}` : 
                                `${myKeyword} & ${partnerRecord.keyword} (${percent}%)`;

                            executeMatch(
                                { id: socket.id, socket: socket, keyword: myKeyword },
                                partnerRecord,
                                matchText
                            );
                        }
                    } else {
                        console.log(`⏰ [${socket.id}] 队列只有自己，继续等待...`);
                    }
                }
            }, 8000); // 8000 毫秒 = 8 秒
        }
    });

    // 其他事件
    socket.on('chat_message', (d) => socket.to(d.room).emit('message_received', d));
    socket.on('typing', (d) => socket.to(d.room).emit('partner_typing', d));
    socket.on('rejoin_room', (r) => socket.join(r));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 服务器运行中: http://localhost:${PORT}`);
});