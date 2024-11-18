import Redis from 'ioredis';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { exec } from 'child_process';
import { Worker } from 'worker_threads';
import path from 'path';
import { v4 as uuidv4 } from 'uuid'; // 使用命名導入
import fs from 'fs';
import pLimit from 'p-limit';
// import levenshtein from 'fast-levenshtein';
import { createRequire } from 'module';
import mysql from 'mysql2/promise';
const require = createRequire(import.meta.url);
const levenshtein = require('/home/dal/dal-project/server/levenshtein-addon/build/Release/levenshtein');


dotenv.config();

const client = new MongoClient(process.env.MONGODB_URI);
const redis = new Redis(process.env.REDIS_URI);
const statistic_redis = new Redis(process.env.REDIS_URI, { db: 1 });

// 創建一個連接池
// const pool = mysql.createPool({
//     host: process.env.MYSQL_HOST, // MySQL 服務器的主機名
//     user: process.env.MYSQL_USER,      // MySQL 用戶名
//     password: process.env.MYSQL_PASSWORD, // MySQL 密碼
//     database: process.env.MYSQL_DATABASE // 要連接的數據庫名稱
// });

async function get_sql_connection() {
    const connection = await mysql.createConnection({
        host: process.env.MYSQL_HOST,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE
    });

    return connection;
}

const channel = process.env.EXECUTE_CHANNEL; // 設定要訂閱的頻道
redis.subscribe(channel); // 訂閱頻道

// 定義同時執行編譯任務的限制
const limit = pLimit(parseInt(process.env.NUMBER_OF_CONCURRENT_TASKS, 10));

function regularize(text) {
    return text.replace(/\t/g, ' ') // 將 tab 換成空格
        .replace(/ {2,}/g, ' ') // 將連續出現2個或以上的空格換成1個
        .replace(/\n{2,}/g, '\n') // 將連續出現2個或以上的換行換成1個
        .replace(/ \n/g, '\n') // 當空格和換行連在一起時，只保留換行
        .replace(/\n /g, '\n') // 當換行和空格連在一起時，只保留換行
        .replace(/ \n/g, '\n') // 當空格和換行連在一起時，只保留換行
        .toLowerCase() // 將所有的英文字母轉換為小寫
        .trim(); // 移除頭尾的空白字元
}

function eliminate_uncertainty(text) {
    return text.trim()
        .replace(/\s+/g, ''); // 移除所有的空白字元
        //.replace(/(?<=L \= )\d+?(?=\n)/g, '此處不檢查')
        //.replace(/(?<=T \= )\d+(\.\d+)?(?= ms)/g, '此處不檢查')
}

function cal_diff(output, ans) {
    output = regularize(output);
    ans = regularize(ans);
    /*
    const diff_result = []
    const num_of_diff = 0
    return { diff_result, num_of_diff }
    */
    return new Promise((resolve, reject) => {
        const worker = new Worker('./diffWorker.js', { workerData: { output, ans } });

        worker.on('message', (result) => {
            resolve(result);
        });

        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0)
                reject(new Error(`Worker stopped with exit code ${code}`));
        });
    });
}

function to_ms(time) {
    const time_regex = /(\d+)m(\d+\.\d+)s/;
    const time_match = time.match(time_regex);
    const minutes = parseInt(time_match[1]);
    const seconds = parseFloat(time_match[2]);
    const time_in_ms = (minutes * 60 + seconds) * 1000;
    return time_in_ms;
}

function getTermFrequencyMap(str) {
    const words = str.split('');
    const termFrequency = {};
    words.forEach(word => {
        termFrequency[word] = (termFrequency[word] || 0) + 1;
    });
    return termFrequency;
}

function addKeysToDictionary(dict, keys) {
    keys.forEach(key => {
        dict[key] = true;
    });
}

function getCosineSimilarity(strA, strB) {
    const termFrequencyA = getTermFrequencyMap(strA);
    const termFrequencyB = getTermFrequencyMap(strB);

    const dict = {};
    addKeysToDictionary(dict, Object.keys(termFrequencyA));
    addKeysToDictionary(dict, Object.keys(termFrequencyB));

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    Object.keys(dict).forEach(key => {
        const termA = termFrequencyA[key] || 0;
        const termB = termFrequencyB[key] || 0;
        dotProduct += termA * termB;
        magnitudeA += termA * termA;
        magnitudeB += termB * termB;
    });

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);

    if (magnitudeA && magnitudeB) {
        return dotProduct / (magnitudeA * magnitudeB);
    } else {
        return 0;
    }
}

async function compare_file(filename, output_files, ans_files, state) {
    if (state !== 'AC' && state !== 'WA' && state !== 'PE') {
        const error_data = JSON.stringify({ diff_num: -1 });
        await statistic_redis.rpush(`error_len:${filename}`, error_data);
        return state;
    }


    let file_state = state;
    // 先確認有沒有輸出檔案
    if (ans_files) {
        for (const ans_file of ans_files) {
            try {
                // 找到相同檔名的檔案
                const output_file = output_files.find(element => element.filename === ans_file.filename);
                const std_output_file = output_file.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
                const ans_output_file = ans_file.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
                if ( std_output_file === ans_output_file) {
                    file_state = 'AC';
                } else {
                    if ( std_output_file.replace(/\s+/g, '') === ans_output_file.replace(/\s+/g, '') ) {
                        if (file_state !== 'WA') {
                            file_state = 'PE';
                        }
                    }

                    else {
                        file_state = 'WA';
                    }
                }
            }
            catch (err) {
                console.log("Error: ", err);
            }
        }
    }

    return file_state;
    // const min_similarity = Math.min(...all_similarity)
    // const data = JSON.stringify({ diff_num: min_similarity });
    // await statistic_redis.rpush(`error_len:${filename}`, data);
    // return min_similarity;
}

// 執行學生的程式
async function execute(filename, homework, type, compile_folder = 'compiled', execute_folder = 'execute') {
    const execute_collection = client.db('dal').collection('execute_log');
    const command_collection = client.db('dal').collection('command_file');
    const dependency_collection = client.db('dal').collection('dependance_file');
    const upload_log_collection = client.db('dal').collection('upload_log');
    const compile_path = path.join(compile_folder, filename);
    

    const { upload_id, upload_student } = (await upload_log_collection.findOne({ filename }));


    // 從資料庫中找出所有command
    const commands = await command_collection.find({ homework: homework, type: type }).toArray();

    const all_command_function = commands.map(command => limit(async () => {
        // 在execute中建立一個隨機名字的資料夾
        const execute_path = path.join(execute_folder, uuidv4()); // execute_path為ran的路徑
        const execute_file = path.join(execute_path, 'program'); // 所有執行檔都是program
        const input_file = path.join(execute_path, 'in.txt'); // 所有的command都是in.txt
        await fs.promises.mkdir(execute_path);

        const dependencies = await dependency_collection.find({ homework_name: homework }).toArray();
        // 將每次作業的相關檔案放到ran資料夾下
        for (const dependence of dependencies) {
            if (dependence.filename.endsWith('bin')) {
                await fs.promises.writeFile(path.join(execute_path, dependence.filename), dependence.content, { encoding: 'binary' });
            } else {
                await fs.promises.writeFile(path.join(execute_path, dependence.filename), dependence.content);
            }

        }

        // 將同學的執行檔複製到ran下
        await fs.promises.copyFile(compile_path, execute_file);

        // 將command寫成檔案放到ran/in.txt中
        await fs.promises.writeFile(input_file, command.content);

        // 執行command
        await new Promise((resolve, reject) => {
            const timeout = Math.max((command.real_time / 1000) * parseInt(process.env.TIME_LIMIT_MULTIPLY, 10), parseInt(process.env.TIME_LIMIT, 10));
            console.log('Timestamp: ' + new Date().toISOString() + ' start execute ' + execute_path + ' in case ' + command.test_num + ' with timeout ' + timeout + 's');
            exec(`cd ${execute_path} && timeout ${timeout}s firejail --quiet /bin/bash -c "ulimit -s 16384 && { time ./program < in.txt; } 2> time.txt"`, { maxBuffer: 10240 * 1024 * parseInt(process.env.MAX_BUFFER_SIZE_MULTIPLY) }, async (error, stdout, stderr) => {
                console.log('Timestamp: ' + new Date().toISOString() + ' finished execute ' + execute_path + ' in case ' + command.test_num + ' with timeout ' + timeout + 's');
                stdout = stdout.trim();
                stderr = stderr.trim();
                let state;
                if (eliminate_uncertainty(stdout) === eliminate_uncertainty(command.stdout)) {
                    state = 'AC';
                } else if (regularize(eliminate_uncertainty(stdout)) === regularize(eliminate_uncertainty(command.stdout))) {
                    state = 'PE';
                } else {
                    state = 'WA';
                }

                if (error) {
                    stdout = ""; // 只要發生錯誤就將stdout清空
                    if (error.code === 124) {
                        // 遇到無窮迴圈或timeout
                        state = 'TLE';
                    } else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
                        state = 'OLE';
                    } else {
                        // 其他錯誤
                        state = 'RE';
                    }
                }

                const diff_result_list = [];
                const { diff_result, num_of_diff } = await cal_diff(stdout, command.stdout);
                // 比對輸出結果
                diff_result_list.push({ item: 'stdout', diff: num_of_diff, diff_result: diff_result });

                let output_file = [];
                // 如果有寫檔的規定
                // 新增名為output_file的陣列，裡面放著所有的檔案名稱和內容
                if (command.generated_files) {
                    for (const generated_file of command.generated_files) {
                        if (state !== 'AC' && state !== 'WA' && state !== 'PE') {
                            output_file.push({ filename: generated_file.filename, content: state });
                            diff_result_list.push({ item: generated_file.filename, diff: -1 });
                            continue;
                        }

                        let content;
                        try {
                            content = await fs.promises.readFile(path.join(execute_path, generated_file.filename), 'utf-8');
                        } catch (err) {
                            content = `缺少: ${generated_file.filename}`;
                        }

                        output_file.push({ filename: generated_file.filename, content: content });

                        if (content !== null) {
                            const { diff_result, num_of_diff } = await cal_diff(content, generated_file.content);
                            diff_result_list.push({ item: generated_file.filename, diff: num_of_diff, diff_result: diff_result });
                        } else {
                            diff_result_list.push({ item: generated_file.filename, diff: -1 });
                        }
                    }
                }


                // 新增比對檔案功能，不需要計算cosine 比對output_file與command_generated_files
                // 改為吃SQL的資料庫
                // 拔掉cal_error_ratio

                try {
                    // 解析time.txt
                    const time_txt = await fs.promises.readFile(path.join(execute_path, 'time.txt'), 'utf-8');
                    const regex = /real\s*(\d+m\d+\.\d+s)\nuser\s*(\d+m\d+\.\d+s)\nsys\s*(\d+m\d+\.\d+s)/;
                    const match = time_txt.match(regex);
                    var real_time = to_ms(match[1]);
                    var user_time = to_ms(match[2]);
                    var sys_time = to_ms(match[3]);
                } catch (err) {
                    var real_time = -1;
                    var user_time = -1;
                    var sys_time = -1;
                }

                const time_usage = JSON.stringify({ student: user_time + sys_time, teacher: command.cpu_time });
                await statistic_redis.rpush(`cpu_time:${filename}`, time_usage);

                // 計算錯誤率
                const final_state = await compare_file(filename, output_file, command.generated_files, state);

                // 紀錄這個test case的執行狀態
                const execute_state = JSON.stringify({ test_num: parseInt(command.test_num), state: final_state });
                await statistic_redis.rpush(`execute_state:${filename}`, execute_state);

                try {
                    const connection = await get_sql_connection();
                    
                    const [executionLogResult] = await connection.query(
                        'INSERT INTO execution_log (execute_time, student_id, filename, homework, type, state, test_num, cpu_time, relative_time, real_time, user_time, sys_time, evaluation_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [
                            new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).toISOString().slice(0, 19).replace('T', ' '),
                            upload_student,
                            filename,
                            homework,
                            type,
                            final_state,
                            parseInt(command.test_num),
                            user_time + sys_time,
                            (user_time + sys_time) / command.cpu_time,
                            real_time,
                            user_time,
                            sys_time,
                            0
                        ]
                    );

                    const executionLogId = executionLogResult.insertId;

                    // 將學生的stdout寫入資料庫
                    await connection.query(
                        'INSERT INTO output_stream (stream, content, execution_log_id) VALUES (?, ?, ?)',
                        [
                            "stdout",
                            stdout,
                            executionLogId
                        ]
                    );

                    // 將標準答案寫入資料庫
                    await connection.query(
                        'INSERT INTO output_stream (stream, content, execution_log_id) VALUES (?, ?, ?)',
                        [
                            "stdout_ans",
                            command.stdout,
                            executionLogId
                        ]
                    );

                    await connection.query(
                        'INSERT INTO output_stream (stream, content, execution_log_id) VALUES (?, ?, ?)',
                        [
                            "stderr",
                            stderr,
                            executionLogId
                        ]
                    )

                    if (command.generated_files) {
                        // 將學生生成的檔案寫入資料庫
                        for (const file of output_file) {
                            await connection.query(
                                'INSERT INTO output_stream (stream, content, execution_log_id) VALUES (?, ?, ?)',
                                [
                                    file.filename,
                                    file.content,
                                    executionLogId
                                ]
                            );
                        }

                        // 將標準答案生成的檔案寫入資料庫
                        for (const generated_file of command.generated_files) {
                            await connection.query(
                                'INSERT INTO output_stream (stream, content, execution_log_id) VALUES (?, ?, ?)',
                                [
                                    `${generated_file.filename}_ans`,
                                    generated_file.content,
                                    executionLogId
                                ]
                            );
                        }
                    }

                    await connection.end();
                    // await execute_collection.insertOne({
                    //     uploadTime: new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }),
                    //     filename: filename,
                    //     homework: homework,
                    //     type: type,
                    //     state: state,
                    //     cpu_time: user_time + sys_time,
                    //     relative_time: (user_time + sys_time) / command.cpu_time,
                    //     real_time: real_time,
                    //     user_time: user_time,
                    //     sys_time: sys_time,
                    //     stdout: stdout,
                    //     ans: command.stdout,
                    //     ans_file: command.generated_files,
                    //     output_file: output_file,
                    //     stderr: stderr,
                    //     test_num: command.test_num,
                    //     diff_result: diff_result_list,
                    //     error_ratio: error_ratio
                    // });
                } catch (err) {
                    console.log(err);
                    // await execute_collection.insertOne({
                    //     uploadTime: new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }),
                    //     filename: filename,
                    //     homework: homework,
                    //     type: type,
                    //     state: state,
                    //     cpu_time: user_time + sys_time,
                    //     relative_time: (user_time + sys_time) / command.cpu_time,
                    //     real_time: real_time,
                    //     user_time: user_time,
                    //     sys_time: sys_time,
                    //     stdout: stdout,
                    //     ans: command.stdout,
                    //     ans_file: command.generated_files,
                    //     output_file: [],
                    //     stderr: stderr,
                    //     test_num: command.test_num,
                    //     diff_result: [],
                    //     error_ratio: error_ratio
                    // });
                }

                // 當所有test case都執行完畢，就開始統計執行結果
                if (await statistic_redis.llen(`cpu_time:${filename}`) === commands.length) {
                    const statistic_execute_collection = client.db('dal').collection('static_execute_log');

                    let student_time = 0;
                    let teacher_time = 0;
                    (await statistic_redis.lrange(`cpu_time:${filename}`, 0, -1)).forEach((time) => {
                        const time_obj = JSON.parse(time);
                        if (time_obj.student > 0) {
                            student_time += time_obj.student;
                            teacher_time += time_obj.teacher;
                        }
                    });

                    if (teacher_time === 0) {
                        var average_cpu_time = -999; // 一個都沒有執行成功
                    } else {
                        var average_cpu_time = student_time / teacher_time;
                    }

                    var min_similarity = 999;
                    (await statistic_redis.lrange(`error_len:${filename}`, 0, -1)).forEach((error) => {
                        const error_obj = JSON.parse(error);
                        if (error_obj.diff_num >= 0 && min_similarity > error_obj.diff_num) {
                            min_similarity = error_obj.diff_num;
                        }
                    });

                    if (min_similarity === 999) {
                        min_similarity = -1;
                    }

                    const all_state = (await statistic_redis.lrange(`execute_state:${filename}`, 0, -1))
                        .sort((a, b) => JSON.parse(a).test_num - JSON.parse(b).test_num)
                        .map((state) => JSON.parse(state).state);

                    var level;
                    if (all_state.every(s => s === 'AC')) {
                        level = 1;
                    } else if (all_state.some(s => s === 'AC')) {
                        level = 2;
                    } else {
                        level = 3;
                    }

                    await statistic_execute_collection.insertOne({
                        filename: filename,
                        homework: homework,
                        upload_id: upload_id,
                        type: type,
                        avg_cpu_time: average_cpu_time,
                        avg_error_ratio: min_similarity,
                        all_state: all_state,
                        level: level
                    });

                    await statistic_redis.del(`cpu_time:${filename}`);
                    await statistic_redis.del(`error_len:${filename}`);
                    await statistic_redis.del(`execute_state:${filename}`);
                    console.log(`Execute ${filename} done!`);
                }

                await fs.promises.rm(execute_path, { recursive: true, force: true });
                resolve();
            });
        });
    }));

    await Promise.all(all_command_function);
}

// 監聽訂閱事件
redis.on('message', async (channel, message) => {
    const upload_collection = client.db('dal').collection('upload_log');
    const upload_id = message; // 假設 message 本身就是 upload_id
    const cppFile = await upload_collection.findOne({ filename: upload_id });

    await execute(cppFile.filename, cppFile.homework, cppFile.type);
});
