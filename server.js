// server.js (调试专用版)
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { initAI, getVector, calculateMatch } = require('./ai-service');

const CONFIG = {
    ENABLE_AI_BOT: false,
    ENABLE_VECTOR_MATCH: true,
    FAKE_ONLINE_COUNT: false
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

if (CONFIG.ENABLE_VECTOR_MATCH) {
    initAI().catch(e => console.error("AI Init Warning:", e));
}

let waitingQueue = []; 
const userHistory = new Map(); 
const deviceSocketMap = new Map(); 
const pendingInvites = new Map();
const BOT_ROOMS = new Set();
const MAX_HISTORY = 5;
let realConnectionCount = 0;

function updateUserHistory(deviceId, keyword, vector) {
    if (!deviceId || !keyword) return;
    const now = Date.now();
    let history = userHistory.get(deviceId) || [];
    history = history.filter(h => (now - h.time < 43200000) && (h.keyword !== keyword));
    history.unshift({ keyword, vector, time: now });
    if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
    userHistory.set(deviceId, history);
    console.log(`💾 [历史] 设备 ${deviceId} 更新历史: ${keyword} (当前历史数: ${history.length})`);
}

function isUserIdle(socketId) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) {
        console.log(`⚠️ [状态检查] Socket ${socketId} 不存在`);
        return false;
    }
    const isQueueing = waitingQueue.some(u => u.id === socketId);
    const isChatting = socket.rooms.size > 1; 
    
    // 调试日志
    if(isQueueing) console.log(`⚠️ [状态检查] 用户 ${socketId} 正在排队中 (忙碌)`);
    if(isChatting) console.log(`⚠️ [状态检查] 用户 ${socketId} 正在聊天室中 (忙碌)`);
    
    return !isQueueing && !isChatting;
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

io.on('connection', (socket) => {
    realConnectionCount++;
    const deviceId = socket.handshake.auth.deviceId;

    if (deviceId) {
        deviceSocketMap.set(deviceId, socket.id);
        console.log(`🔗 [连入] Socket: ${socket.id} 绑定设备: ${deviceId}`);
    } else {
        console.log(`⚠️ [连入] Socket: ${socket.id} 没有 DeviceID (无法记录历史)`);
    }
    
    io.emit('online_count', realConnectionCount + (CONFIG.FAKE_ONLINE_COUNT ? 100 : 0));

    socket.on('disconnect', () => {
        realConnectionCount--;
        waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
        if (deviceId && deviceSocketMap.get(deviceId) === socket.id) {
            deviceSocketMap.delete(deviceId);
        }
    });

    socket.on('search_match', async (rawInput) => {
        // 清理旧状态
        Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });

        const myKeyword = rawInput ? rawInput.trim() : "随便";
        let myVector = null;

        if (CONFIG.ENABLE_VECTOR_MATCH) {
            try { myVector = await getVector(myKeyword); } catch (e) {}
        }

        if (deviceId) updateUserHistory(deviceId, myKeyword, myVector);

        // 1. 优先匹配排队者
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

        // 2. 先入队
        addToQueue(socket, deviceId, myKeyword, myVector);

        // 3. 异步召回逻辑 (带详细日志)
        setTimeout(() => {
            if (!waitingQueue.find(u => u.id === socket.id)) return; // 已经不在队列了

            console.log(`🔎 [召回] 用户 ${socket.id} 开始扫描历史用户...`);
            console.log(`   - 当前历史池中有 ${userHistory.size} 个设备`);
            console.log(`   - 当前在线设备映射表有 ${deviceSocketMap.size} 个`);

            let bestHistorySocketId = null;
            let maxHistoryScore = -1;
            let historyTopic = "";

            for (const [targetDeviceId, historyList] of userHistory.entries()) {
                // 跳过自己
                if (targetDeviceId === deviceId) {
                    continue;
                }

                const targetSocketId = deviceSocketMap.get(targetDeviceId);
                
                // 检查在线状态
                if (!targetSocketId) {
                    // console.log(`   - 设备 ${targetDeviceId} 不在线，跳过`);
                    continue;
                }

                // 检查忙碌状态
                if (!isUserIdle(targetSocketId)) {
                    console.log(`   - 设备 ${targetDeviceId} (Socket ${targetSocketId}) 在线但在忙，跳过`);
                    continue;
                }

                console.log(`   - 正在检查候选人: ${targetDeviceId} (Socket ${targetSocketId})`);

                // 检查历史记录匹配度
                for (const hItem of historyList) {
                    const hResult = calculateMatch(myKeyword, hItem.keyword, myVector, hItem.vector);
                    // console.log(`     - 对比 "${myKeyword}" vs "${hItem.keyword}" 得分: ${hResult.score}`);

                    if (hResult.score > maxHistoryScore && hResult.score >= 0.6) {
                        maxHistoryScore = hResult.score;
                        bestHistorySocketId = targetSocketId;
                        historyTopic = `${myKeyword} & ${hItem.keyword}`;
                        console.log(`     ★ 发现高匹配! 得分: ${hResult.score}`);
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
                    targetSocket.emit('match_invite', { inviterId: socket.id, topic: historyTopic });
                    console.log(`🔔 [发送邀请] ${socket.id} -> ${bestHistorySocketId} 成功!`);
                } else {
                    console.log(`❌ [发送邀请] 失败，目标 Socket ${bestHistorySocketId} 找不到对象`);
                }
            } else {
                console.log(`💨 [召回] 扫描结束，未找到合适的历史用户`);
            }
        }, 500); // 延迟 500ms 方便看日志
    });

    socket.on('accept_invite', (data) => {
        const inviterId = data.inviterId;
        const inviteId = `${inviterId}_to_${socket.id}`;
        const inviteData = pendingInvites.get(inviteId);

        if (!inviteData) return socket.emit('invite_error', '邀请已过期');
        pendingInvites.delete(inviteId); 

        const isInviterAvailable = waitingQueue.some(u => u.id === inviterId);
        const inviterSocket = io.sockets.sockets.get(inviterId);
        const { keyword, info } = inviteData; 

        if (inviterSocket && isInviterAvailable) {
            waitingQueue = waitingQueue.filter(u => u.id !== inviterId);
            executeMatch({ id: inviterId, socket: inviterSocket, keyword: keyword }, { id: socket.id, socket: socket }, info);
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