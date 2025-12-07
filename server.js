// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { initAI, getVector, calculateMatch } = require('./ai-service');

// =================配置区=================
const CONFIG = {
    ENABLE_AI_BOT: false,       
    ENABLE_VECTOR_MATCH: true,  
    FAKE_ONLINE_COUNT: false    
};
// =======================================

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

if (CONFIG.ENABLE_VECTOR_MATCH) {
    initAI().catch(e => console.error("AI Init Warning:", e));
}

// --- 数据结构 ---
let waitingQueue = []; 
const userHistory = new Map(); 
const deviceSocketMap = new Map(); 
const pendingInvites = new Map();
const BOT_ROOMS = new Set();
const MAX_HISTORY = 5;
let realConnectionCount = 0;

// --- 辅助函数 ---
function updateUserHistory(deviceId, keyword, vector) {
    if (!deviceId || !keyword) return;
    const now = Date.now();
    let history = userHistory.get(deviceId) || [];
    history = history.filter(h => (now - h.time < 43200000) && (h.keyword !== keyword));
    history.unshift({ keyword, vector, time: now });
    if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
    userHistory.set(deviceId, history);
}

// 🔴 修改：判断用户是否“可用” (排队中也算可用，只有在聊天中才算忙)
function isUserAvailableForRecall(socket) {
    if (!socket) return false;
    // socket.rooms 默认包含 1 个 ID 房间。如果 > 1 说明加入了聊天室 (room_xxx)
    const isChatting = socket.rooms.size > 1; 
    return !isChatting; // 只要没在聊天，哪怕在排队，也可以被召回
}

function executeMatch(userA, userB, matchInfo) {
    const roomID = 'room_' + Date.now();
    [userA, userB].forEach(u => {
        const s = u.socket || io.sockets.sockets.get(u.id);
        if(s) {
            s.join(roomID);
            Array.from(s.rooms).forEach(r => { if(r !== s.id && r !== roomID) s.leave(r); });
        }
    });
    BOT_ROOMS.delete(roomID);
    const s1 = Math.floor(Math.random() * 1000);
    const s2 = Math.floor(Math.random() * 1000);
    const payload = { room: roomID, keyword: matchInfo };
    const socketA = userA.socket || io.sockets.sockets.get(userA.id);
    const socketB = userB.socket || io.sockets.sockets.get(userB.id);

    if(socketA) socketA.emit('match_found', { ...payload, partnerId: userB.id, myAvatar: s1, partnerAvatar: s2 });
    if(socketB) socketB.emit('match_found', { ...payload, partnerId: userA.id, myAvatar: s2, partnerAvatar: s1 });
    
    console.log(`✅ 匹配成功: ${matchInfo}`);
}

function addToQueue(socket, deviceId, keyword, vector) {
    waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
    waitingQueue.push({ id: socket.id, deviceId, keyword, vector, socket: socket, startTime: Date.now() });
    socket.emit('waiting_in_queue', keyword);
    console.log(`⏳ 入队: ${keyword} (队列:${waitingQueue.length}人)`);
}

// ================= Socket 主逻辑 =================
io.on('connection', (socket) => {
    realConnectionCount++;
    const deviceId = socket.handshake.auth.deviceId;

    if (deviceId) deviceSocketMap.set(deviceId, socket.id);
    
    io.emit('online_count', realConnectionCount + (CONFIG.FAKE_ONLINE_COUNT ? 100 : 0));
    console.log(`➕ 连入: ${socket.id}`);

    socket.on('disconnect', () => {
        realConnectionCount--;
        waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
        if (deviceId && deviceSocketMap.get(deviceId) === socket.id) {
            deviceSocketMap.delete(deviceId);
        }
    });

    socket.on('search_match', async (rawInput) => {
        Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });

        const myKeyword = rawInput ? rawInput.trim() : "随便";
        let myVector = null;

        if (CONFIG.ENABLE_VECTOR_MATCH) {
            try { myVector = await getVector(myKeyword); } catch (e) {}
        }

        if (deviceId) updateUserHistory(deviceId, myKeyword, myVector);

        // 1. 优先匹配【正在排队】的真人 (当前意图匹配)
        let bestIndex = -1;
        let maxScore = -1;
        let matchedInfoText = "";

        for (let i = 0; i < waitingQueue.length; i++) {
            const waiter = waitingQueue[i];
            if (waiter.id === socket.id) continue;

            let result = calculateMatch(myKeyword, waiter.keyword, myVector, waiter.vector);
            if (result.score > maxScore && result.score >= 0.5) {
                maxScore = result.score;
                bestIndex = i;
                matchedInfoText = `${myKeyword} & ${waiter.keyword}`;
            }
        }

        if (bestIndex !== -1) {
            const partner = waitingQueue[bestIndex];
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id && u.id !== partner.id);
            executeMatch({ id: socket.id, socket: socket, keyword: myKeyword }, partner, matchedInfoText);
            return;
        }

        // 2. 没找到现成的，先入队
        addToQueue(socket, deviceId, myKeyword, myVector);

        // 3. 异步尝试召回在线的历史用户 (包括正在排队但在搜其他词的人)
        setTimeout(() => {
            if (!waitingQueue.find(u => u.id === socket.id)) return;

            console.log(`🔎 [召回] 用户 ${socket.id} 扫描中...`);

            let bestHistorySocketId = null;
            let maxHistoryScore = -1;
            let historyTopic = "";

            for (const [targetDeviceId, historyList] of userHistory.entries()) {
                if (targetDeviceId === deviceId) continue; // 跳过自己
                
                const targetSocketId = deviceSocketMap.get(targetDeviceId);
                if (!targetSocketId) continue; // 必须在线

                const targetSocket = io.sockets.sockets.get(targetSocketId);
                
                // 🔴 关键修改：只要没在聊天室里，哪怕在排队，也可以被召回
                if (!isUserAvailableForRecall(targetSocket)) {
                    // console.log(`   [跳过] 用户 ${targetSocketId} 正在聊天中`);
                    continue;
                }

                for (const hItem of historyList) {
                    const hResult = calculateMatch(myKeyword, hItem.keyword, myVector, hItem.vector);
                    
                    if (hResult.score > maxHistoryScore && hResult.score >= 0.6) {
                        maxHistoryScore = hResult.score;
                        bestHistorySocketId = targetSocketId;
                        historyTopic = `${myKeyword} & ${hItem.keyword}`;
                    }
                }
            }

            if (bestHistorySocketId) {
                const inviteId = `${socket.id}_to_${bestHistorySocketId}`;
                pendingInvites.set(inviteId, {
                    inviterId: socket.id,
                    inviteeId: bestHistorySocketId,
                    keyword: myKeyword,
                    info: historyTopic + " (历史召回)"
                });

                const targetSocket = io.sockets.sockets.get(bestHistorySocketId);
                if (targetSocket) {
                    targetSocket.emit('match_invite', { 
                        inviterId: socket.id, 
                        topic: historyTopic 
                    });
                    console.log(`🔔 尝试召回: ${socket.id} -> ${bestHistorySocketId}`);
                }
            }
        }, 500);
    });

    // --- 处理：接受邀请 ---
    socket.on('accept_invite', (data) => {
        const inviterId = data.inviterId;
        const inviteId = `${inviterId}_to_${socket.id}`;
        const inviteData = pendingInvites.get(inviteId);

        if (!inviteData) return socket.emit('invite_error', '邀请已过期');
        pendingInvites.delete(inviteId); 

        // 检查发起者是否还在等待
        const isInviterAvailable = waitingQueue.some(u => u.id === inviterId);
        const inviterSocket = io.sockets.sockets.get(inviterId);
        const { keyword, info } = inviteData; 

        if (inviterSocket && isInviterAvailable) {
            // ✅ 匹配成功
            // 1. 把发起者移除队列
            waitingQueue = waitingQueue.filter(u => u.id !== inviterId);
            
            // 2. 🔴 关键补充：把接受者(我自己)也从队列移除 
            // (因为我可能也正在排队搜别的东西)
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
            
            executeMatch(
                { id: inviterId, socket: inviterSocket, keyword: keyword },
                { id: socket.id, socket: socket },
                info
            );
        } else {
            socket.emit('invite_error', '手慢了，对方已匹配到其他人');
        }
    });

    socket.on('decline_invite', (data) => {
        const inviteId = `${data.inviterId}_to_${socket.id}`;
        pendingInvites.delete(inviteId);
    });

    socket.on('chat_message', (d) => socket.to(d.room).emit('message_received', d));
    socket.on('typing', (d) => socket.to(d.room).emit('partner_typing', d.isTyping));
    socket.on('rejoin_room', (r) => socket.join(r));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 服务启动: http://localhost:${PORT}`);
});