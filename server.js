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
initAI();

// 全局状态
let waitingQueue =[];
let onlineCount = 0;
const deviceSocketMap = new Map();
const userHistory = new Map();
const pendingInvites = new Map();

const CONFIG = { ENABLE_VECTOR_MATCH: true, FAKE_ONLINE_COUNT: false };

// 辅助函数：判断用户是否空闲 (不在任何聊天室)
function isUserAvailableForRecall(socket) {
    if (!socket) return false;
    const rooms = Array.from(socket.rooms);
    // 只在自己的专属ID房间，说明没有在单聊或群聊中
    return rooms.length === 1 && rooms[0] === socket.id;
}

// 辅助函数：执行 1v1 匹配
function executeMatch(p1, p2, infoText) {
    const roomID = 'room_' + Date.now();
    p1.socket.join(roomID);
    p2.socket.join(roomID);

    const s1 = Math.floor(Math.random() * 1000);
    const s2 = Math.floor(Math.random() * 1000);

    const payload = { room: roomID, keyword: infoText };
    p1.socket.emit('match_found', { ...payload, partnerId: p2.id, myAvatar: s1, partnerAvatar: s2 });
    p2.socket.emit('match_found', { ...payload, partnerId: p1.id, myAvatar: s2, partnerAvatar: s1 });
    console.log(`✅ 1v1匹配成功: ${p1.id} <-> ${p2.id} [${infoText}]`);
}

function updateUserHistory(deviceId, keyword, vector) {
    if (!userHistory.has(deviceId)) userHistory.set(deviceId,[]);
    const history = userHistory.get(deviceId);
    if (!history.find(h => h.keyword === keyword)) {
        history.push({ keyword, vector, time: Date.now() });
        if (history.length > 10) history.shift();
    }
}

io.on('connection', (socket) => {
    onlineCount++;
    const deviceId = socket.handshake.auth.deviceId;
    if (deviceId) deviceSocketMap.set(deviceId, socket.id);
    
    io.emit('online_count', onlineCount + (CONFIG.FAKE_ONLINE_COUNT ? 100 : 0));
    console.log(`➕ 连入: ${socket.id}`);

    socket.on('disconnecting', () => {
        const rooms = Array.from(socket.rooms);
        rooms.forEach(room => {
            if (room === socket.id) return;
            if (room.startsWith('room_')) {
                socket.to(room).emit('partner_left');
            } else if (room.startsWith('group_')) {
                const roomSize = (io.sockets.adapter.rooms.get(room)?.size || 1) - 1;
                if (roomSize > 0) socket.to(room).emit('system_message', `👋 一位玩家离开了房间，当前剩余 ${roomSize} 人`);
            }
        });
    });

    socket.on('disconnect', () => {
        onlineCount--;
        io.emit('online_count', onlineCount);
        waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
        if (deviceId && deviceSocketMap.get(deviceId) === socket.id) deviceSocketMap.delete(deviceId);
    });

    socket.on('search_match', async (rawInput) => {
        Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });

        const myKeyword = rawInput ? rawInput.trim() : "综合大厅";
        let myVector = null;
        if (CONFIG.ENABLE_VECTOR_MATCH) {
            try { myVector = await getVector(myKeyword); } catch (e) {}
        }
        if (deviceId) updateUserHistory(deviceId, myKeyword, myVector);

        // ==========================================
        // 🌟 1. 群聊检查 (精确命中)
        // ==========================================
        const groupRoomID = `group_${myKeyword}`;
        const groupRoom = io.sockets.adapter.rooms.get(groupRoomID);

        // 情形 A：群聊已存在
        if (groupRoom && groupRoom.size > 0) {
            socket.join(groupRoomID);
            const myAvatarSeed = Math.floor(Math.random() * 1000);
            socket.emit('group_match_success', { room: groupRoomID, keyword: myKeyword, myAvatarSeed, memberCount: groupRoom.size });
            socket.to(groupRoomID).emit('system_message', `✨ 欢迎新玩家加入，当前共 ${groupRoom.size} 人`);
            return;
        }

        // 情形 B：有完全一样词的玩家在排队 -> 携手建群
        let exactIndex = waitingQueue.findIndex(u => u.keyword === myKeyword && u.id !== socket.id);
        if (exactIndex !== -1) {
            const partner = waitingQueue[exactIndex];
            waitingQueue.splice(exactIndex, 1);
            const partnerSocket = io.sockets.sockets.get(partner.id);
            if (partnerSocket) {
                socket.join(groupRoomID);
                partnerSocket.join(groupRoomID);
                socket.emit('group_match_success', { room: groupRoomID, keyword: myKeyword, myAvatarSeed: Math.floor(Math.random()*1000), memberCount: 2 });
                partnerSocket.emit('group_match_success', { room: groupRoomID, keyword: myKeyword, myAvatarSeed: Math.floor(Math.random()*1000), memberCount: 2 });
                return;
            }
        }

        // ==========================================
        // 🌟 2. 1v1 单聊检查 (模糊命中)
        // ==========================================
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
                matchedInfoText = `${myKeyword} & ${waiter.keyword} (${Math.round(result.score*100)}%)`;
            }
        }

        if (bestIndex !== -1) {
            const partner = waitingQueue[bestIndex];
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id && u.id !== partner.id);
            executeMatch({ id: socket.id, socket: socket, keyword: myKeyword }, partner, matchedInfoText);
            return;
        }

        // ==========================================
        // 🌟 3. 入队排队 & 历史召回
        // ==========================================
        waitingQueue.push({ id: socket.id, socket: socket, keyword: myKeyword, vector: myVector });
        socket.emit('waiting_in_queue');

        setTimeout(() => {
            if (!waitingQueue.find(u => u.id === socket.id)) return;
            let bestHistorySocketId = null;
            let maxHistoryScore = -1;
            let historyTopic = "";

            for (const [targetDeviceId, historyList] of userHistory.entries()) {
                if (targetDeviceId === deviceId) continue;
                const targetSocketId = deviceSocketMap.get(targetDeviceId);
                if (!targetSocketId) continue;
                
                const targetSocket = io.sockets.sockets.get(targetSocketId);
                if (!isUserAvailableForRecall(targetSocket)) continue;

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
                pendingInvites.set(inviteId, { inviterId: socket.id, inviteeId: bestHistorySocketId, keyword: myKeyword, info: historyTopic + " (召回)" });
                const targetSocket = io.sockets.sockets.get(bestHistorySocketId);
                if (targetSocket) {
                    targetSocket.emit('match_invite', { inviterId: socket.id, topic: historyTopic });
                    socket.emit('waiting_for_invite');
                }
            }
        }, 500);
    });

    socket.on('accept_invite', (data) => {
        const inviterId = data.inviterId;
        const inviteId = `${inviterId}_to_${socket.id}`;
        const inviteData = pendingInvites.get(inviteId);
        if (!inviteData) return socket.emit('invite_error', '邀请已过期');
        pendingInvites.delete(inviteId); 

        const isInviterAvailable = waitingQueue.some(u => u.id === inviterId);
        const inviterSocket = io.sockets.sockets.get(inviterId);
        if (inviterSocket && isInviterAvailable) {
            waitingQueue = waitingQueue.filter(u => u.id !== inviterId && u.id !== socket.id);
            executeMatch({ id: inviterId, socket: inviterSocket, keyword: inviteData.keyword }, { id: socket.id, socket: socket }, inviteData.info);
        } else {
            socket.emit('invite_error', '手慢了，对方已离开');
        }
    });

    socket.on('decline_invite', (data) => pendingInvites.delete(`${data.inviterId}_to_${socket.id}`));
    socket.on('chat_message', (d) => socket.to(d.room).emit('message_received', d));
    socket.on('typing', (d) => socket.to(d.room).emit('partner_typing', d));
    socket.on('rejoin_room', (r) => socket.join(r));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 服务器运行中: http://localhost:${PORT}`));