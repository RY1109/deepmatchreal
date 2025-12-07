// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
// 引入 ai-service (注意：移除了 getAIChatReply，因为目前未使用机器人聊天)
const { initAI, getVector, calculateMatch } = require('./ai-service');

// =================配置区=================
const CONFIG = {
    ENABLE_AI_BOT: false,       // 机器人功能目前未启用
    ENABLE_VECTOR_MATCH: true,  // 是否开启 AI 向量
    FAKE_ONLINE_COUNT: false    // 是否造假人数
};
// =======================================

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// 初始化 AI
if (CONFIG.ENABLE_VECTOR_MATCH) {
    initAI().catch(e => console.error("AI Init Error:", e));
}

// --- 数据结构 ---
let waitingQueue = []; 
const userHistory = new Map(); // DeviceId -> 历史记录数组
const deviceSocketMap = new Map(); // DeviceId -> SocketId (追踪在线状态)
const pendingInvites = new Map(); // 存储发出的邀请
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

// 检查用户是否空闲 (不在聊天室，也不在排队)
function isUserIdle(socketId) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) return false;
    // 检查是否在排队
    const isQueueing = waitingQueue.some(u => u.id === socketId);
    // 检查是否在聊天 (rooms > 1 说明加入了除了自身ID以外的房间)
    const isChatting = socket.rooms.size > 1; 
    return !isQueueing && !isChatting;
}

// 执行匹配
function executeMatch(userA, userB, matchInfo) {
    const roomID = 'room_' + Date.now();
    
    // 双方加入房间
    [userA, userB].forEach(u => {
        const s = u.socket || io.sockets.sockets.get(u.id);
        if(s) {
            s.join(roomID);
            // 离开旧房间
            Array.from(s.rooms).forEach(r => {
                if(r !== s.id && r !== roomID) s.leave(r);
            });
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

// 加入队列通用函数
function addToQueue(socket, deviceId, keyword, vector) {
    waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
    
    waitingQueue.push({ 
        id: socket.id, deviceId, keyword, vector, 
        socket: socket, startTime: Date.now() 
    });
    
    socket.emit('waiting_in_queue', keyword);
    console.log(`⏳ 入队: ${keyword} (队列:${waitingQueue.length}人)`);

    // 机器人/系统消息兜底
    setTimeout(() => {
        const meStillHere = waitingQueue.find(u => u.id === socket.id);
        if (meStillHere) {
            if (CONFIG.ENABLE_AI_BOT) {
                // 如果启用了机器人，这里调用机器人逻辑
                // ...
            } else {
                // 没启用机器人，只提示
                socket.emit('system_message', '暂无真人匹配，正在持续搜索...'); 
            }
        }
    }, 8000);
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

    // --- 核心匹配请求 ---
    socket.on('search_match', async (rawInput) => {
        Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });

        const myKeyword = rawInput ? rawInput.trim() : "随便";
        let myVector = null;

        if (CONFIG.ENABLE_VECTOR_MATCH) {
            try { myVector = await getVector(myKeyword); } catch (e) {}
        }

        if (deviceId) updateUserHistory(deviceId, myKeyword, myVector);

        // 1. 优先匹配【正在排队】的真人
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

        // 2. 没找到，先入队
        addToQueue(socket, deviceId, myKeyword, myVector);

        // 3. 异步尝试召回在线的历史用户
        setTimeout(() => {
            if (!waitingQueue.find(u => u.id === socket.id)) return;

            let bestHistorySocketId = null;
            let maxHistoryScore = -1;
            let historyTopic = "";

            for (const [targetDeviceId, historyList] of userHistory.entries()) {
                if (targetDeviceId === deviceId) continue;
                
                const targetSocketId = deviceSocketMap.get(targetDeviceId);
                if (!targetSocketId || !isUserIdle(targetSocketId)) continue;

                for (const hItem of historyList) {
                    const hResult = calculateMatch(myKeyword, hItem.keyword, myVector, hItem.vector);
                    // 历史召回门槛 0.6
                    if (hResult.score > maxHistoryScore && hResult.score >= 0.6) {
                        maxHistoryScore = hResult.score;
                        bestHistorySocketId = targetSocketId;
                        historyTopic = `${myKeyword} & ${hItem.keyword}`;
                    }
                }
            }

            if (bestHistorySocketId) {
                // 存入邀请记录
                const inviteId = `${socket.id}_to_${bestHistorySocketId}`;
                pendingInvites.set(inviteId, {
                    inviterId: socket.id,
                    inviteeId: bestHistorySocketId,
                    keyword: myKeyword,
                    info: historyTopic + " (历史召回)"
                });

                // 给对方发通知
                const targetSocket = io.sockets.sockets.get(bestHistorySocketId);
                if (targetSocket) {
                    targetSocket.emit('match_invite', { 
                        inviterId: socket.id, 
                        topic: historyTopic 
                    });
                    console.log(`🔔 尝试召回: ${socket.id} -> ${bestHistorySocketId}`);
                }
            }
        }, 100);
    });

    // --- 处理：接受邀请 (修复版) ---
    socket.on('accept_invite', (data) => {
        const inviterId = data.inviterId;
        const inviteId = `${inviterId}_to_${socket.id}`;
        const inviteData = pendingInvites.get(inviteId);

        // 1. 邀请是否有效
        if (!inviteData) return socket.emit('invite_error', '邀请已过期');
        
        pendingInvites.delete(inviteId); 

        // 2. 检查发起者是否还在排队 (抢占检查)
        const isInviterAvailable = waitingQueue.some(u => u.id === inviterId);
        const inviterSocket = io.sockets.sockets.get(inviterId);

        // ✅ 修正：不再解构不存在的 inviter 对象，直接用 inviterSocket
        const { keyword, info } = inviteData; 

        if (inviterSocket && isInviterAvailable) {
            // 从队列移除发起者
            waitingQueue = waitingQueue.filter(u => u.id !== inviterId);
            
            executeMatch(
                { id: inviterId, socket: inviterSocket, keyword: keyword },
                { id: socket.id, socket: socket },
                info
            );
        } else {
            socket.emit('invite_error', '手慢了，对方已匹配到其他人');
        }
    });

    // --- 处理：拒绝邀请 ---
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