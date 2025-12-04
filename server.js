const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// === AI 模型配置 ===
let extractor = null; // 用来存放 AI 模型实例

// 初始化 AI 模型 (异步加载)
async function initAI() {
    console.log("正在加载 AI 模型 (第一次运行可能需要下载 30-50MB)...");
    // 动态导入 transformer 库
    const { pipeline } = await import('@xenova/transformers');
    // 加载一个轻量级的中文/多语言嵌入模型
    // 'Xenova/all-MiniLM-L6-v2' 是目前性价比最高的轻量模型
    extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5');
    console.log("✅ AI 模型加载完成！准备进行语义匹配。");
}

// 启动时加载模型
initAI();

// --- 核心算法：计算余弦相似度 ---
// 传入两个向量，返回相似度 (0 ~ 1)
function cosineSimilarity(vecA, vecB) {
    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
}

// 存储等待队列，现在不仅存 ID，还存 向量数据
// 结构: [{ id: '...', keyword: '...', vector: [...] }]
let waitingQueue = [];
let onlineCount = 0;

io.on('connection', (socket) => {
    onlineCount++;
    io.emit('online_count', onlineCount);

    // --- 监听：寻找匹配 (AI 版) ---
    socket.on('search_match', async (rawInput) => {
        // 如果模型还没加载好，提示用户稍等
        if (!extractor) {
            socket.emit('system_message', 'AI 引擎正在预热，请稍后再试...');
            return;
        }

        const myKeyword = rawInput ? rawInput.trim() : "随便聊聊";
        console.log(`用户 ${socket.id} 输入: "${myKeyword}" -> 正在生成向量...`);

        // 1. AI 转换：将用户输入的文字变成向量 (Vector)
        // mean_pooling: true 表示取整句话的平均特征
        const output = await extractor(myKeyword, { pooling: 'mean', normalize: true });
        const myVector = Array.from(output.data); // 转成普通数组

        // 2. 遍历队列，计算 AI 相似度
        let bestMatchIndex = -1;
        let maxScore = -1;
        const MATCH_THRESHOLD = 0.5; // 相似度门槛 (0.4 ~ 0.5 通常比较准)

        for (let i = 0; i < waitingQueue.length; i++) {
            const waiter = waitingQueue[i];
            
            // 计算我和这个等待者的相似度
            const score = cosineSimilarity(myVector, waiter.vector);
            console.log(`AI 对比: [${myKeyword}] vs [${waiter.keyword}] = 相似度 ${score.toFixed(2)}`);

            if (score > maxScore && score >= MATCH_THRESHOLD) {
                maxScore = score;
                bestMatchIndex = i;
            }
        }

        if (bestMatchIndex !== -1) {
            // === 匹配成功 ===
            const partnerInfo = waitingQueue[bestMatchIndex];
            const partnerSocket = io.sockets.sockets.get(partnerInfo.id);

            // 移除队列
            waitingQueue.splice(bestMatchIndex, 1);

            if (partnerSocket) {
                const roomID = 'room_' + Date.now();
                socket.join(roomID);
                partnerSocket.join(roomID);

                const seed1 = Math.floor(Math.random() * 1000);
                const seed2 = Math.floor(Math.random() * 1000);
                
                // 将匹配度转为百分比
                const matchPercent = Math.round(maxScore * 100);
                const commonTopic = `${myKeyword} & ${partnerInfo.keyword}`;

                socket.emit('match_found', { 
                    partnerId: partnerInfo.id, room: roomID, myAvatar: seed1, partnerAvatar: seed2,
                    keyword: `${commonTopic} (契合度:${matchPercent}%)`
                });
                partnerSocket.emit('match_found', { 
                    partnerId: socket.id, room: roomID, myAvatar: seed2, partnerAvatar: seed1,
                    keyword: `${commonTopic} (契合度:${matchPercent}%)`
                });

                console.log(`✅ AI 匹配成功! 相似度: ${matchPercent}%`);
            } else {
                // 对方掉线，把自己加回去
                waitingQueue.push({ id: socket.id, keyword: myKeyword, vector: myVector });
            }

        } else {
            // === 没匹配到，加入队列 ===
            // 存入我的向量，供后人匹配
            waitingQueue.push({ 
                id: socket.id, 
                keyword: myKeyword, 
                vector: myVector 
            });
            console.log(`未匹配，已加入队列。当前队列人数: ${waitingQueue.length}`);
            socket.emit('waiting_in_queue', myKeyword);
        }
    });

    // ... (以下是聊天和断开连接的逻辑，保持不变) ...
    socket.on('chat_message', (data) => {
        socket.to(data.room).emit('message_received', data);
    });
    
    socket.on('typing', (data) => {
        socket.to(data.room).emit('partner_typing', data.isTyping);
    });

    socket.on('disconnect', () => {
        onlineCount--;
        io.emit('online_count', onlineCount);
        waitingQueue = waitingQueue.filter(user => user.id !== socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器运行中 (AI版): http://localhost:${PORT}`);
});