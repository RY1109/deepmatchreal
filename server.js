const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let waitingUser = null;
let onlineCount = 0; // 新增：在线人数统计

io.on('connection', (socket) => {
    // 1. 更新在线人数
    onlineCount++;
    io.emit('online_count', onlineCount); // 广播给所有人

    // 2. 监听：寻找匹配
    socket.on('search_match', (keywords) => {
        if (waitingUser && waitingUser.id !== socket.id) {
            const roomID = 'room_' + Date.now();
            const partner = waitingUser;

            socket.join(roomID);
            partner.join(roomID);

            // 分配随机头像种子
            const seed1 = Math.floor(Math.random() * 1000);
            const seed2 = Math.floor(Math.random() * 1000);

            // 通知匹配成功 (带上头像种子)
            socket.emit('match_found', { partnerId: partner.id, room: roomID, myAvatar: seed1, partnerAvatar: seed2 });
            partner.emit('match_found', { partnerId: socket.id, room: roomID, myAvatar: seed2, partnerAvatar: seed1 });

            waitingUser = null;
        } else {
            waitingUser = socket;
        }
    });

    // 3. 监听：发送消息
    socket.on('chat_message', (data) => {
        socket.to(data.room).emit('message_received', data);
    });

    // 4. 新增：监听“正在输入”
    socket.on('typing', (data) => {
        socket.to(data.room).emit('partner_typing', data.isTyping);
    });

    // 5. 断开连接
    socket.on('disconnect', () => {
        onlineCount--;
        io.emit('online_count', onlineCount); // 更新人数
        if (waitingUser && waitingUser.id === socket.id) {
            waitingUser = null;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});