const redis = require('redis');

const STREAM_KEY = 'my_stream';
const GROUP_NAME = 'my_group';
const CONSUMER_NAME = process.argv[2] || 'consumer_1';

// 使用指定的 Redis 伺服器 URI 創建 Redis 客戶端
const client = redis.createClient({ url: 'redis://192.168.100.139:6379' });

client.on('error', (err) => {
    console.error('Redis client error:', err);
});

// 創建 Consumer Group
async function createConsumerGroup() {
    try {
        await client.connect();
        await client.xGroupCreate(STREAM_KEY, GROUP_NAME, '$', { MKSTREAM: true });
        console.log('Consumer group created');
    } catch (err) {
        if (err.message.includes('BUSYGROUP')) {
            console.log('Consumer group already exists');
        } else {
            console.error('Error creating consumer group:', err);
        }
    }
}

// Consumer 處理消息
async function consumeMessages() {
    try {
        while (true) {
            try {
                const messages = await client.xReadGroup(GROUP_NAME, CONSUMER_NAME, { key: STREAM_KEY, id: '>' }, { COUNT: 1, BLOCK: 5000 });
                console.log('Messages:', JSON.stringify(messages, null, 2)); // 添加日誌檢查返回的消息
                if (messages) {
                    for (const streamMessage of messages) {
                        const { name: stream, messages: messageArray } = streamMessage;
                        for (const message of messageArray) {
                            const [messageId, messageContent] = message;
                            console.log(`Consumer ${CONSUMER_NAME} processing message: ${messageContent.message}`);
                            // 處理完消息後，確認消息
                            await client.xAck(STREAM_KEY, GROUP_NAME, messageId);
                        }
                    }
                }
            } catch (err) {
                console.error(`Error consuming messages with consumer ${CONSUMER_NAME}:`, err);
            }
        }
    } catch (err) {
        console.error('Error in consumer loop:', err);
    } finally {
        await client.disconnect();
    }
}

(async () => {
    await createConsumerGroup();
    await consumeMessages();
})();
