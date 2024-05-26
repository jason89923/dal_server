const redis = require('redis');

// 使用指定的 Redis 伺服器 URI 創建 Redis 客戶端
const client = redis.createClient({ url: 'redis://192.168.100.139:6379' });

client.on('error', (err) => {
    console.error('Redis client error:', err);
});

const STREAM_KEY = 'my_stream';

// Publisher 發送消息到 Stream
async function publishMessages(messages) {
    try {
        await client.connect();
        for (const message of messages) {
            await client.xAdd(STREAM_KEY, '*', { message });
            console.log(`Message published: ${message}`);
        }
    } catch (err) {
        console.error('Error publishing message:', err);
    } finally {
        await client.disconnect();
    }
}

// 發佈測試消息
const messages = ['Hello, World!', 'Hello, Redis Streams!', 'Hello, Consumer Group!'];
publishMessages(messages);
