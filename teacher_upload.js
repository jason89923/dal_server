const { MongoClient } = require('mongodb');
const fs = require('fs');
require('dotenv').config();
const path = require('path');
const uuid = require('uuid');
const { exec } = require('child_process');
const { set } = require('lodash');
const AsyncQueue = require('./AsyncQueue');

const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URI);

const client = new MongoClient(process.env.MONGODB_URI);

async function read_and_upload_dependent_files(dir, homework_name) {
    try {
        const files = await fs.promises.readdir(path.join(dir, homework_name));
        const input_files = files.filter(file => file.startsWith('input') || file.startsWith('pairs'));

        for (const file of input_files) {
            let data;
            if (file.endsWith('bin')) {
                data = await fs.promises.readFile(path.join(dir, homework_name, file), { encoding: 'binary' });
            } else {
                data = await fs.promises.readFile(path.join(dir, homework_name, file));
            }

            const content = data.toString();

            const collection = client.db('dal').collection('dependance_file');
            await collection.updateOne({ homework_name: homework_name, filename: file }, { $set: { content: content } }, { upsert: true });
        }
    } catch (err) {
        console.log(err);
    }
}

async function read_and_upload_command(dir, homework_name) {
    try {
        const files = await fs.promises.readdir(path.join(dir, homework_name));
        const input_files = files.filter(file => file.startsWith('COM'));

        for (const file of input_files) {
            const data = await fs.promises.readFile(path.join(dir, homework_name, file));
            const content = JSON.parse(data)

            const collection = client.db('dal').collection('command_file');

            const filenameWithoutExtension = path.parse(file).name;
            for (const item of content) {
                const test_unit = item.test_unit.map(str => str.replace(/\s+/g, '\n')).join('\n') + '\n';
                await collection.updateOne({ homework: homework_name, type: filenameWithoutExtension.split('_')[1], test_num: item.test_num.toString(), description: item.description }, { $set: { content: test_unit, test_unit_object: JSON.stringify(item.test_unit) } }, { upsert: true });
                if (item.predecessor !== undefined) {
                    for (const predecessor of item.predecessor) {
                        await collection.updateOne({ homework: homework_name, type: filenameWithoutExtension.split('_')[1], test_num: predecessor.toString() }, { $push: {relation_edge: item.test_num.toString()} });
                    }
                }
            }
            // await collection.updateOne({ homework: homework_name, type: filenameWithoutExtension.split('_')[1], test_num: filenameWithoutExtension.split('_')[2], filename: file }, { $set: { content: content } }, { upsert: true });
        }
    } catch (err) {
        console.log(err);
    }
}

function to_ms(time) {
    const time_regex = /(\d+)m(\d+\.\d+)s/;
    const time_match = time.match(time_regex);
    const minutes = parseInt(time_match[1]);
    const seconds = parseFloat(time_match[2]);
    const time_in_ms = (minutes * 60 + seconds) * 1000;
    return time_in_ms;
}

async function execute(input_dir, homework_name) {
    const dependance_file_collection = client.db('dal').collection('dependance_file');
    const command_collection = client.db('dal').collection('command_file');
    const all_promise = [];

    const files = await fs.promises.readdir(path.join(input_dir, homework_name));

    // 只取出cpp檔案
    const cpp_files = files.filter(file => file.endsWith('.cpp'));

    for (const cpp_file of cpp_files) {
        // 取出檔案名稱
        const pure_cpp_file_name = path.parse(cpp_file).name;

        // 從資料庫中找出相關的測試檔案
        const results = await command_collection.find({ homework: homework_name, type: pure_cpp_file_name }).toArray();

        results.forEach(result => {
            all_promise.push(() => new Promise(async (resolve, reject) => {
                // 生成一個隨機的資料夾名稱
                const current_execute_folder = uuid.v4();

                // 建立資料夾
                await fs.promises.mkdir(path.join('execute', current_execute_folder));

                // 把測試檔案寫入到資料夾中
                await fs.promises.writeFile(path.join('execute', current_execute_folder, 'in.txt'), result.content);

                // 取得測試編號
                const test_num = result.test_num;

                // 把cpp檔案寫入到資料夾中
                await fs.promises.copyFile(path.join(input_dir, homework_name, cpp_file), path.join('execute', current_execute_folder, 'program.cpp'));

                // 從資料庫中找出相關的附檔
                const dependance_results = await dependance_file_collection.find({ homework_name: homework_name }).toArray();

                for (const dependance_result of dependance_results) {
                    // 把附檔寫入到資料夾中
                    if (dependance_result.filename.endsWith('bin')) {
                        await fs.promises.writeFile(path.join('execute', current_execute_folder, dependance_result.filename), dependance_result.content, { encoding: 'binary' });
                    } else {
                        await fs.promises.writeFile(path.join('execute', current_execute_folder, dependance_result.filename), dependance_result.content);
                    }
                }

                // 編譯程式
                console.log('Timestamp: ' + new Date().toISOString() + ' cd ' + path.join('execute', current_execute_folder) + ' && g++ program.cpp -o program');
                exec('cd ' + path.join('execute', current_execute_folder) + ' && g++ program.cpp -o program', async (error, stdout, stderr) => {
                    if (error) {
                        console.log('error: ' + error.message);
                        return;
                    }
                    if (stderr) {
                        console.log('stderr: ' + stderr);
                        return;
                    }

                    // 執行程式
                    console.log('Timestamp: ' + new Date().toISOString() + ' cd ' + path.join('execute', current_execute_folder) + ' && timeout 300s firejail --quiet /bin/bash -c "{ time ./program < in.txt; } 2> time.txt"');
                    exec('cd ' + path.join('execute', current_execute_folder) + ' && timeout 300s firejail --quiet /bin/bash -c "ulimit -s 16384 && { time ./program < in.txt; } 2> time.txt"', { maxBuffer: 10240 * 1024 }, async (error, stdout, stderr) => {
                        if (error) {
                            console.error('test num ' + test_num + ' error: ' + error.message + ' - Timestamp: ' + new Date().toISOString());
                            // 刪除資料夾
                            await fs.promises.rm(path.join('execute', current_execute_folder), { recursive: true, force: true });
                            await redis.set(`current_teacher_upload_fail`, 'true', 'EX', 60 * 60 * 24);
                            resolve();
                            return;
                        }

                        // 把程式的輸出寫入到資料庫中
                        await command_collection.updateOne({ homework: homework_name, type: pure_cpp_file_name, test_num: test_num }, { $set: { stdout: stdout } });

                        // 列出所有附檔的檔案名稱
                        const dependance_file_names = set(dependance_results.map(result => result.filename));
                        // 找出程式生成的檔案
                        const all_txt_files = (await fs.promises.readdir(path.join('execute', current_execute_folder))).filter(file => (file.endsWith('.txt') || file.endsWith('.cnt') || file.endsWith('.adj')) && file !== 'in.txt' && file !== 'time.txt' && !dependance_file_names.includes(file));


                        // 讀取執行時間
                        const time_txt = await fs.promises.readFile(path.join('execute', current_execute_folder, 'time.txt'), 'utf-8');

                        const regex = /real\s*(\d+m\d+\.\d+s)\nuser\s*(\d+m\d+\.\d+s)\nsys\s*(\d+m\d+\.\d+s)/;
                        const match = time_txt.match(regex);
                        const real_time = to_ms(match[1]);
                        const user_time = to_ms(match[2]);
                        const sys_time = to_ms(match[3]);

                        await command_collection.updateOne({
                            homework: homework_name,
                            type: pure_cpp_file_name,
                            test_num: test_num,
                        },
                            {
                                $set: {
                                    cpu_time: user_time + sys_time,
                                    real_time: real_time,
                                    user_time: user_time,
                                    sys_time: sys_time,
                                }
                            }, (err, result) => {
                                if (err) {
                                    console.log(err);
                                } else {
                                    console.log(result);
                                }
                            });


                        // 把程式生成的檔案寫入到資料庫中
                        for (const output_file of all_txt_files) {
                            // 讀取檔案
                            data = await fs.promises.readFile(path.join('execute', current_execute_folder, output_file));

                            // 轉成字串
                            const content = data.toString();

                            // 匯集資料
                            const information = {
                                filename: output_file,
                                content: content
                            };

                            // 寫入資料庫
                            await command_collection.updateOne({
                                homework: homework_name,
                                type: pure_cpp_file_name,
                                test_num: test_num,
                            },
                                {
                                    $push: { generated_files: information }
                                }, (err, result) => {
                                    if (err) {
                                        console.log(err);
                                    } else {
                                        console.log(result);
                                    }
                                });
                        }

                        // 刪除資料夾
                        await fs.promises.rm(path.join('execute', current_execute_folder), { recursive: true, force: true });
                        resolve()
                    });
                });

            }));
        })
    }

    return all_promise;
}

async function check_file_existence(file_path, homework_name) {
    const all_files = await fs.promises.readdir(path.join(file_path, homework_name));

    const input_files = []
    const command_files = []
    const cpp_files = []

    // 分類檔案
    for (const file of all_files) {
        if (/^[a-z]{5}\d{3}\.[a-z]{3}$/.test(file)) {
            input_files.push(file);
        } else if (/^COM_(DEMO[a-z]*|QUIZ[a-z]*)\.json$/.test(file)) {
            const cpp_name = path.parse(file).name.split('_')[1]
            if (!all_files.includes(`${cpp_name}.cpp`)) {
                throw new Error(`指令檔找不到對應的cpp檔案: ${cpp_name}.cpp`);
            }
            command_files.push(file);
        } else if (/(DEMO[a-z]*|QUIZ[a-z]*).cpp$/.test(file)) {
            cpp_files.push(file);
        } else {
            throw new Error(`檔案格式錯誤: ${file}`);
        }
    }
}

async function upload(homework_name) {
    const input_dir = 'answer_file'

    const dependance_file_collection = client.db('dal').collection('dependance_file');
    const command_collection = client.db('dal').collection('command_file');

    await dependance_file_collection.deleteMany({ homework_name: homework_name });
    await command_collection.deleteMany({ homework: homework_name });

    await read_and_upload_dependent_files(input_dir, homework_name);
    await read_and_upload_command(input_dir, homework_name);
    const asyncQueue = new AsyncQueue();
    const all_promise = await execute(input_dir, homework_name);
    await asyncQueue.processQueue(all_promise);
}


exports.check_file = check_file_existence;
exports.upload = upload;