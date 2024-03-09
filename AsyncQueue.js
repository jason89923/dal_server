const async = require('async');
require('dotenv').config();


class AsyncQueue {
    constructor() {
        this.queue = async.queue(async (task, callback) => {
            // 假設 task 是一個返回 Promise 的異步函數
            await task().then(callback).catch(callback);
        }, parseInt(process.env.NUMBER_OF_CONCURRENT_TASKS));
    }

    processQueue(tasks) {
        return new Promise((resolve, reject) => {

            if (tasks.length === 0) {
                resolve();
                return;
            }
            // 向隊列中添加任務
            tasks.forEach(task => this.queue.push(task));

            // 當隊列中的所有任務都完成時，解決Promise
            this.queue.drain(() => resolve());
        });
    }
}

module.exports = AsyncQueue;