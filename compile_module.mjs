import Redis from 'ioredis';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import pLimit from 'p-limit';

dotenv.config();

const client = new MongoClient(process.env.MONGODB_URI);
const redis_sub = new Redis(process.env.REDIS_URI);
const redis_pub = new Redis(process.env.REDIS_URI);

(async () => {
  const channel = process.env.COMPILE_CHANNEL; // 設定要訂閱的頻道
  redis_sub.subscribe(channel); // 訂閱頻道

  // 定義同時執行編譯任務的限制 (最多4個任務)
  const limit = pLimit(parseInt(process.env.NUMBER_OF_CONCURRENT_TASKS, 10));

  // 監聽訂閱事件
  redis_sub.on('message', async (channel, message) => {
    try {
      // 連線到 upload_log 和 compiled_log
      const upload_collection = client.db('dal').collection('upload_log');
      const compiled_collection = client.db('dal').collection('compiled_log');
      const static_execute_collection = client.db('dal').collection('static_execute_log');

      // message 就是 filename
      const cppFile = await upload_collection.findOne({ filename: message });

      const filename = cppFile.filename; // 從資料庫找出cpp名稱
      const original = cppFile.originalname; // 從資料庫找出原始檔名

      await limit(() => compile(filename, original)); // 控制每次4個任務，其餘排隊等候

      const compiledFile = await compiled_collection.findOne({ filename, state: 'success' }); // 找出編譯成功的檔案

      if (compiledFile) {
        // 有成功編譯在publish到執行端
        await redis_pub.publish(process.env.EXECUTE_CHANNEL, filename);
      }

      else {
        // 編譯失敗直接寫進 static_execute_log
        await static_execute_collection.insertOne({ 
          filename: filename, 
          homework: cppFile.homework,
          upload_id: cppFile.upload_id,
          type: cppFile.type,
          avg_cpu_time: -9999,
          avg_error_ratio: -9999,
          all_state: ['CE'],
          level: 0
        });
      }

    } catch (err) {
      console.error('compile module 錯誤：', err);
    }

  });

  // 錯誤處理
  redis_sub.on('error', (err) => {
    console.error('compile module Redis錯誤：', err);
  });

  function compile(filename, originalname, upload_folder = 'uploads', compile_folder = 'compiled') {
    return new Promise((resolve, reject) => {
      // 連線 mongodb 到 compiled_log
      const compiled_collection = client.db('dal').collection('compiled_log');
      const upload_path = path.join(upload_folder, filename);
      const compile_path = path.join(compile_folder, filename);

      // 編譯指令
      const command = `mv ${upload_path} ${upload_path}.cpp && g++ ${upload_path}.cpp -o ${compile_path}`;

      exec(command, async (error, stdout, stderr) => {
        if (error) {
          // 記錄錯誤訊息
          var message = error.message.replaceAll(`${upload_path}.cpp`, originalname);
        }

        // 寫到mongodb的compiled_log
        await compiled_collection.insertOne({ filename: filename, state: error ? 'compile error' : 'success', message: message });

        // 編譯完成後重命名檔案
        fs.rename(`${upload_path}.cpp`, `${upload_path}`, function (err) {
          if (err) {
            console.log('無法重新命名檔案：', err);
            reject(err);
            return;
          }
          resolve();
        });

      });

    });
  }
})();
