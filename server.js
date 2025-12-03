const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 1. 设置静态文件目录，让用户能访问到 HTML
app.use(express.static(path.join(__dirname, 'public')));

// 2. 简单的匹配队列
let waitingUser = null; // 存储正在等待的用户

io.on('connection', (socket) => {
    console.log('有新用户连接:', socket.id);

    // --- 监听：用户发起匹配请求 ---
    socket.on('search_match', (keywords) => {
        console.log(`用户 ${socket.id} 正在寻找: ${keywords}`);
        
        // 如果当前有别人在等待，且不是自己
        if (waitingUser && waitingUser.id !== socket.id) {
            // === 匹配成功！ ===
            const roomID = 'room_' + Date.now();
            const partner = waitingUser;

            // 1. 把两人加入同一个房间
            socket.join(roomID);
            partner.join(roomID);

            // 2. 通知两人匹配成功
            // 告诉当前用户 (socket)
            socket.emit('match_found', { 
                partnerId: partner.id, 
                room: roomID,
                role: 'initiator' 
            });
            // 告诉对方 (partner)
            partner.emit('match_found', { 
                partnerId: socket.id, 
                room: roomID,
                role: 'receiver'
            });

            console.log(`匹配成功: ${socket.id} <-> ${partner.id} in ${roomID}`);
            
            // 清空等待队列
            waitingUser = null;

        } else {
            // === 没有人在等待，加入队列 ===
            waitingUser = socket;
            console.log(`用户 ${socket.id} 加入等待队列...`);
        }
    });

    // --- 监听：发送消息 ---
    socket.on('chat_message', (data) => {
        // data 包含: { room: '...', msg: '...' }
        // 广播给房间里的其他人（除了自己）
        socket.to(data.room).emit('message_received', data.msg);
    });

    // --- 监听：用户断开连接 ---
    socket.on('disconnect', () => {
        console.log('用户断开:', socket.id);
        // 如果断开的人正好在排队，把队列清空
        if (waitingUser && waitingUser.id === socket.id) {
            waitingUser = null;
        }
    });
});

// 启动服务器，监听 3000 端口
server.listen(3000, () => {
    console.log('服务器已启动: http://localhost:3000');
});