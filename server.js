// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { initAI, getVector, calculateMatch } = require('./ai-service'); // 引入 AI 服务

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 启动 AI
initAI();

let waitingQueue = [];

io.on('connection', (socket) => {
    onlineCount++;
    io.emit('online_count', onlineCount);

    socket.on('search_match', async (rawInput) => {
        // ✅ 新增：在开始新匹配前，强制离开所有旧房间
        // socket.rooms 是一个 Set，包含用户当前所在的所有房间
        const currentRooms = Array.from(socket.rooms);
        currentRooms.forEach(room => {
            // socket.id 是默认的私人房间，不能退，其他的都退掉
            if (room !== socket.id) {
                socket.leave(room);
            }
        });
        const myKeyword = rawInput ? rawInput.trim() : "随便";
        console.log(`🔍 用户 ${socket.id} 搜索: ${myKeyword}`);

        // 获取向量
        const myVector = await getVector(myKeyword);
        if (!myVector) {
            socket.emit('system_message', 'AI 引擎正在预热，请稍后...');
            return;
        }

        let bestIndex = -1;
        let maxScore = -1;

        // 遍历队列寻找最佳匹配
        for (let i = 0; i < waitingQueue.length; i++) {
            const waiter = waitingQueue[i];
            const result = calculateMatch(myKeyword, waiter.keyword, myVector, waiter.vector);
            
            if (result.score > maxScore && result.score >= 0.5) {
                maxScore = result.score;
                bestIndex = i;
            }
        }

        if (bestIndex !== -1) {
            // 匹配成功逻辑
            const partner = waitingQueue[bestIndex];
            waitingQueue.splice(bestIndex, 1);
            const partnerSocket = io.sockets.sockets.get(partner.id);

            if (partnerSocket) {
                const roomID = 'room_' + Date.now();
                socket.join(roomID);
                partnerSocket.join(roomID);

                const percent = Math.round(maxScore * 100);
                const info = `${myKeyword} & ${partner.keyword} (${percent}%)`;
                const s1 = Math.floor(Math.random() * 1000);
                const s2 = Math.floor(Math.random() * 1000);

                const payload = { room: roomID, keyword: info };
                socket.emit('match_found', { ...payload, partnerId: partner.id, myAvatar: s1, partnerAvatar: s2 });
                partnerSocket.emit('match_found', { ...payload, partnerId: socket.id, myAvatar: s2, partnerAvatar: s1 });
            }
        } else {
            // 加入队列
            waitingQueue.push({ id: socket.id, keyword: myKeyword, vector: myVector });
            socket.emit('waiting_in_queue', myKeyword);
        }
    });

    // 通用事件转发
    socket.on('chat_message', (d) => socket.to(d.room).emit('message_received', d));
    socket.on('typing', (d) => socket.to(d.room).emit('partner_typing', d.isTyping));
    socket.on('rejoin_room', (room) => socket.join(room));
    // server.js

    io.on('connection', (socket) => {
        const count = io.engine.clientsCount;
        io.emit('online_count', count);
    
        console.log(`➕ 用户连入: ${socket.id} (在线: ${count})`);

        // ✅ 新增：监听“即将断开”事件 (通知房间里的人)
        socket.on('disconnecting', () => {
            // socket.rooms 是一个 Set，包含该用户当前所在的所有房间
            const rooms = Array.from(socket.rooms);
            
            rooms.forEach(room => {
                // 排除掉自己的 ID 房间，只发给公共聊天室
                if (room !== socket.id) {
                    socket.to(room).emit('system_message', {
                        type: 'system',
                        textKey: 'partnerLeft' // 发送翻译的 Key，而不是死文字
                    });
                }
            });
        });

        // 原有的 disconnect 逻辑保持不变
        socket.on('disconnect', () => {
            const count = io.engine.clientsCount;
            io.emit('online_count', count);
            waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
            console.log(`➖ 用户断开: ${socket.id}`);
        });
    });

    socket.on('disconnect', () => {
        onlineCount--;
        io.emit('online_count', onlineCount);
        waitingQueue = waitingQueue.filter(u => u.id !== socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 服务器运行中: http://localhost:${PORT}`);
});