const express = require('express');
const passport = require('passport');
const chardet = require('chardet');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const cors = require('cors');
const multer = require('multer');
const { MongoClient } = require('mongodb');
const { exec } = require('child_process');
const uuid = require('uuid');
require('dotenv').config();
const archiver = require('archiver');
const levenshtein = require('fast-levenshtein');

const teacher_upload = require('./teacher_upload');


const AsyncQueue = require('./AsyncQueue');

const { Worker } = require('worker_threads');

const diff_match_patch = require('diff-match-patch');

const dmp = new diff_match_patch();

const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URI);

const hljs = require('highlight.js');

function rm(dir) {
    fs.readdir(dir, (err, files) => {
        if (err) throw err;

        for (const file of files) {
            fs.rm(path.join(dir, file), { recursive: true, force: true }, (err) => {
                if (err) throw err;
            });
        }
    });
}

const remove_all = false

if (remove_all) {
    rm('uploads')
    rm('compiled')
}

rm('execute')

const client = new MongoClient(process.env.MONGODB_URI);

const app = express();

// 啟用所有 CORS 請求
app.use(cors());


// app.set('trust proxy', true);


app.use(passport.initialize());

// 設定靜態文件目錄
app.use(express.static('public'));

// 解析 JSON 請求體
app.use(express.json());


const port = process.env.PORT;

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + uuid.v4())
    }
})

const upload = multer({ storage: storage });

const WebSocket_auth = new Set()

app.get('/auth', (req, res) => {
    const token = uuid.v4();
    WebSocket_auth.add(token);
    res.send(token);
});

app.post('/testnum', async (req, res) => {
    const target_file = req.body.target_file;

    const upload_collection = client.db('dal').collection('upload_log');
    const command_collection = client.db('dal').collection('command_file');
    const execute_collection = client.db('dal').collection('execute_log');
    const static_execute_collection = client.db('dal').collection('static_execute_log');
    // 找到所有的test_num
    const document = await upload_collection.findOne({ filename: target_file });

    if (document === null) {
        res.send([]);
        return;
    }

    const type = document.type;
    const homework = document.homework;
    const tests = await command_collection.find({ type: type, homework: homework }).toArray();

    tests.sort((a, b) => a.test_num - b.test_num);

    var test_info = await Promise.all(tests.map(async item => {
        const resultKey = `result:${target_file}:${type}:${homework}:${item.test_num}`;
        const staticResultKey = `static_result:${target_file}`;

        let result = JSON.parse(await redis.get(resultKey));
        let static_result = JSON.parse(await redis.get(staticResultKey));

        if (!result) {
            result = await execute_collection.findOne({ filename: target_file, type: type, homework: homework, test_num: item.test_num });
            await redis.set(resultKey, JSON.stringify(result), 'EX', 60 * 60 * 24 * 7);
        }

        if (!static_result) {
            static_result = await static_execute_collection.findOne({ filename: target_file });
            await redis.set(staticResultKey, JSON.stringify(static_result), 'EX', 60 * 60 * 24 * 7);
        }

        if (static_result === null || result === null) {
            return {
                testnum: item.test_num,
                tag: item.description,
                studentid: document.upload_student,
                state: 'Pending',
                percentage: 'NA',
                execution_time: 'NA',
                relative_time: 'NA',
                type_list: []
            }
        } else if (result.state !== 'AC') {
            return {
                testnum: item.test_num,
                tag: item.description,
                studentid: document.upload_student,
                state: 'Pending',
                percentage: result.state,
                execution_time: result.state,
                relative_time: result.state,
                type_list: []
            }
        }
        return {
            testnum: item.test_num,
            tag: item.description,
            studentid: document.upload_student,
            state: 'Done',
            percentage: result.error_ratio === undefined ? -1 : result.error_ratio.toFixed(3),
            execution_time: result.cpu_time === undefined ? -1 : result.cpu_time.toFixed(3),
            relative_time: result.relative_time === undefined ? -1 : result.relative_time.toFixed(3),
            type_list: ['stdout', ...result.output_file.map(file => file.filename)]
        }
    }));

    res.send(test_info);

});


app.post('/testinfo', async (req, res) => {
    const target_file = req.body.target_file;
    const testnum = req.body.testnum.toString();

    const upload_collection = client.db('dal').collection('upload_log');
    const command_collection = client.db('dal').collection('command_file');
    // 找到所有的test_num
    const document = await upload_collection.findOne({ filename: target_file });

    const type = document.type;
    const homework = document.homework;
    const test = await command_collection.findOne({ type: type, homework: homework, test_num: testnum });


    res.send({ testnum: req.body.testnum, content: JSON.parse(test.test_unit_object) });

});

app.post('/delete_batch', async (req, res) => {
    const upload_id = req.body.upload_id;
    const upload_collection = client.db('dal').collection('upload_log');
    const compiled_collection = client.db('dal').collection('compiled_log');
    const execute_collection = client.db('dal').collection('execute_log');
    const upload_tag_collection = client.db('dal').collection('upload_tag');
    const static_execute_collection = client.db('dal').collection('static_execute_log');

    await static_execute_collection.deleteMany({ upload_id: upload_id });

    const upload_batch = await upload_collection.find({ upload_id: upload_id }).toArray();

    if (upload_batch.length !== 0) {

        await upload_tag_collection.deleteMany({ upload_id: upload_batch[0].upload_id }); // 刪除upload_tag中的tag
        await upload_collection.deleteMany({ upload_id: upload_batch[0].upload_id }); // 最後! 刪除upload_log中的檔案
        // 確定有這個批次的檔案，再刪除
        for (const upload of upload_batch) {
            const file_name = upload.filename;
            await compiled_collection.deleteMany({ filename: file_name }); // 刪除compiled_log中的檔案
            await execute_collection.deleteMany({ filename: file_name });  // 刪除execute_log中的檔案
            await fs.promises.rm(upload.path, { recursive: true, force: true }); // 刪除upload資料夾中的檔案
            await fs.promises.rm(path.join('compiled', upload.filename), { recursive: true, force: true }); // 刪除compiled資料夾中的檔案
        }
    } // if()

    res.send('delete success');

});



app.post('/code', async (req, res) => {
    const filename = req.body.filename;
    try {
        const data = await fs.promises.readFile(path.join('uploads', filename));
        const content = data.toString();

        // 使用highlight.js進行語法高亮
        const result = hljs.highlight(content, { language: 'cpp' }).value;

        // 直接讀取CSS檔案
        const styleData = await fs.promises.readFile(path.join('src', 'vs2015.min.css'));
        const style = `<style>${styleData.toString()}</style>`;

        // 直接讀取JavaScript檔案
        const scriptData1 = await fs.promises.readFile(path.join('src', 'highlight.min.js'));
        const scriptData2 = await fs.promises.readFile(path.join('src', 'highlightjs-line-numbers.min.js'));
        const scripts = `
        <script>${scriptData1.toString()}</script>
        <script>${scriptData2.toString()}</script>
        <script>hljs.highlightAll(); hljs.initLineNumbersOnLoad();</script>
        `;

        // 將CSS樣式、高亮後的代碼和腳本嵌入到HTML中
        const html = `<html><head>${style}</head><body><pre><code class="hljs">${result}</code></pre>${scripts}</body></html>`;

        res.send(html);
    } catch (err) {
        console.log(err);
        res.send(err.message);
    }
});

async function diff2html(diff) {
    var html = dmp.diff_prettyHtml(diff);
    html = html.replaceAll('background', 'color'); // 改字體顏色
    html = html.replaceAll('#e6ffe6', '#6eff6e'); // 綠色
    html = html.replaceAll('#ffe6e6', '#ef5350'); // 紅色
    return html;
}

app.post('/diff', async (req, res) => {
    try {
        const target_file = req.body.target_file; // filename
        const test_num = req.body.testnum.toString(); // test_num
        const output_file = req.body.output_file; // item in diff_result

        const exec_collection = client.db('dal').collection('execute_log');
        const cacheKey = `exec_result:${target_file}:${test_num}`;

        // 檢查 Redis 快取
        let result = JSON.parse(await redis.get(cacheKey));

        if (!result) {
            // 如果快取中沒有結果，從資料庫查詢
            result = await exec_collection.findOne({ filename: target_file, test_num: test_num });

            // 將結果寫入 Redis 快取
            await redis.set(cacheKey, JSON.stringify(result), 'EX', 60 * 60 * 24 * 7);
        }

        // 處理編譯錯誤，相當於沒有結果
        if (result === null) {
            const compiled_collection = client.db('dal').collection('compiled_log');
            const compiled_result = await compiled_collection.findOne({ filename: target_file });    // 從資料庫找出編譯結果
            const error_message = compiled_result.message;
            const result_html = hljs.highlight(error_message, { language: 'bash' }).value;
            const style = '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/10.7.2/styles/vs2015.min.css">';
            const responsiveMeta = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
            const responsiveStyle = `
            <style>
                body {
                    margin: 0;
                    padding: 20px;
                    font-family: Arial, sans-serif;
                }
                pre {
                    white-space: pre-wrap;       /* Since CSS 2.1 */
                    white-space: -moz-pre-wrap;  /* Mozilla, since 1999 */
                    white-space: -pre-wrap;      /* Opera 4-6 */
                    white-space: -o-pre-wrap;    /* Opera 7 */
                    word-wrap: break-word;       /* Internet Explorer 5.5+ */
                }
                @media (max-width: 600px) {
                    body {
                        padding: 10px;
                    }
                }
            </style>
        `;
            const html = `<html><head>${responsiveMeta}${style}${responsiveStyle}</head><body><pre><code>${result_html}</code></pre></body></html>`;
            res.send(html);
            return;
        }

        var html = "";
        const diff = result.diff_result.map(item => {
            if (item.item === output_file) {
                return item;
            }
        }).filter(item => item !== undefined);

        const diff_html = await diff2html(diff[0].diff_result);

        html += `<h1 style=\"font-size: 30px;\"><li>${diff[0].item}:</li></h1><br>` + diff_html


        var error_message = result.stderr;

        if (result.state === 'TLE') {
            error_message = "time limit exceeded";
        } // else if()


        const error_message_html = hljs.highlight(error_message, { language: 'bash' }).value;
        const style = '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/10.7.2/styles/vs2015.min.css">';
        html = `<html><head>${style}</head>` + html + `<pre><code>${error_message_html}</code></pre>`;

        res.send(html);
        return;
    } catch (err) {
        res.send(err.message);
    }

});

async function transcode(filename) {
    const encoding = chardet.detectFileSync(filename); // 檢測編碼

    if (encoding != 'utf-8') {
        const data = await fs.promises.readFile(filename)
        const convertedData = iconv.decode(data, encoding); // 藉由偵測到的編碼解碼
        const newData = iconv.encode(convertedData, 'utf-8'); // 轉換成utf-8
        await fs.promises.writeFile(filename, newData)
    }
}


app.post('/upload', upload.array('files'), async (req, res) => {
    const pattern = /^\d{8}_|^補交_/;

    for (const file of req.files) {
        const originalname = decodeURIComponent(file.originalname);
        if (!pattern.test(originalname)) {
            res.send(`檔名格式錯誤: ${originalname}，檔名必須以學號開頭`);
            for (const cppfile of req.files) {
                fs.promises.rm(cppfile['path'], { recursive: true, force: true });
            }
            return;
        }

        else if (originalname.split('_')[0] === "補交") {
            for (const cppfile of req.files) {
                const cppfilename = decodeURIComponent(cppfile['originalname']);
                if (cppfilename === originalname) {
                    fs.promises.rm(cppfile['path'], { recursive: true, force: true });
                    req.files = req.files.filter(file => decodeURIComponent(file.originalname) !== originalname);
                }
            }
        }
    }

    var upload_id = Date.now() + '-' + uuid.v4();

    const upload_collection = client.db('dal').collection('upload_log');
    const upload_tag_collection = client.db('dal').collection('upload_tag');


    await upload_tag_collection.insertOne({ upload_id: upload_id, tag: req.body.tag });

    for (const file of req.files) {
        // 中文檔名會是亂碼，需要再次確認
        const originalname = decodeURIComponent(file.originalname);

        const upload_student = originalname.split('_')[0];
        const homework = req.body.homeworkName;
        const type = req.body.homeworkType;

        await transcode(file['path']);

        await upload_collection.insertOne({
            uploadTime: new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }),
            upload_id: upload_id, // 上傳批次
            userId: req.body.userId, // 上傳者
            upload_student: upload_student, // 上傳學號
            originalname: originalname, // 上傳檔名
            path: file['path'], // 上傳到的路徑
            filename: file['filename'], // 上傳後的檔名
            destination: file['destination'], // 上傳到的資料夾
            homework: homework, // 第幾次作業
            type: type, // 作業OR挑戰
            onTime: !(originalname.includes('補交') || originalname.includes('補繳')), // 是否補交
            source_ip: req.ip, // 上傳者IP
            size: file['size'] // 檔案大小
        });

        // 利用redis把檔名pub出去
        await redis.publish(process.env.COMPILE_CHANNEL, file['filename']);
    } // for()

    res.send(upload_id);
});

app.get('/hw_list', async (req, res) => {
    const command_collection = client.db('dal').collection('command_file')
    var result = await command_collection.aggregate([
        {
            $group: {
                _id: "$homework", // 分組鍵為 "homework" 欄位
                types: { $addToSet: "$type" } // 收集每個 "homework" 分組的不同 "type" 值
            }
        }
    ]).toArray()

    result = result.map(item => ({
        title: item._id, // 從 _id 字段的最後兩個字符創建標題
        subItems: item.types.map(type => ({
            title: type, // 使用 type 字段的值創建子項目的標題
        })).sort((a, b) => a.title.localeCompare(b.title)) // 對子項目進行排序
    })).sort((a, b) => a.title.localeCompare(b.title)); // 對結果進行排序

    res.send(result);
});

app.post('/hw_upload', async (req, res) => {
    const target_hw = req.body.target_hw;
    const command_collection = client.db('dal').collection('command_file');
    const upload_collection = client.db('dal').collection('upload_log');
    const upload_tag_collection = client.db('dal').collection('upload_tag');

    const commandResult = await command_collection.aggregate([
        { $match: { homework: target_hw } },
        { $group: { _id: "$homework", types: { $addToSet: "$type" } } }
    ]).toArray();

    const all_type_list = commandResult[0].types.sort();

    const result = []
    for (let type of all_type_list) {
        // 找出此作業、此類型的所有上傳批次
        const uploadResults = await Promise.all(
            (await upload_collection.aggregate([
                { $match: { homework: target_hw, type: type } },
                { $group: { _id: "$upload_id" } },
                { $sort: { "_id": -1 } }
            ]).toArray()).map(async result => {
                const tag = (await upload_tag_collection.findOne({ upload_id: result._id })).tag;
                return { ...result, tag: tag };
            })
        );

        result.push({
            type: type,
            uploadResult: uploadResults
        });
    }

    res.send(result);
});

app.post('/hw_upload_batch', async (req, res) => {
    const upload_id = req.body.upload_id;
    const upload_collection = client.db('dal').collection('upload_log');
    const static_execute_collection = client.db('dal').collection('static_execute_log');

    const upload_batch = await upload_collection.find({ upload_id: upload_id }).toArray();

    var current_upload_batch_statistic = await static_execute_collection.find({ upload_id: upload_id }).toArray();
    current_upload_batch_statistic.sort((a, b) => a.avg_cpu_time - b.avg_cpu_time);

    var rank = 1;
    for (let i = 0; i < current_upload_batch_statistic.length; i++) {
        if (current_upload_batch_statistic[i].avg_cpu_time < 0) {
            current_upload_batch_statistic[i].rank = -1;
        } else {
            current_upload_batch_statistic[i].rank = rank;
            rank++;
        }
    }

    const rank_map = new Map(current_upload_batch_statistic.map(item => [item.filename, item.rank]));

    const batch_info = []

    for (const upload of upload_batch) {
        const result = await static_execute_collection.findOne({ filename: upload.filename });
        if (result === null) {
            batch_info.push({
                state: 'Pending',
                upload_student: upload.upload_student,
                filename: upload.filename,
                upload_time: upload.uploadTime,
                onTime: upload.onTime,
                state_list: [],
                result: 'NA',
                level: 'NA',
                avg_time: 'NA'
            });
        } else {
            batch_info.push({
                state: 'Done',
                upload_student: upload.upload_student,
                filename: upload.filename,
                upload_time: upload.uploadTime,
                onTime: upload.onTime,
                state_list: result.all_state,
                result: result.avg_error_ratio.toFixed(3),
                level: result.level,
                avg_time: result.avg_cpu_time.toFixed(2) + ' T/DEMO, Rank: ' + rank_map.get(upload.filename).toString()
            });
        }

    }

    res.send(batch_info);
});

app.post('/register', async (req, res) => {
    user_group = client.db('dal').collection('user_group');
    user_group.insertOne(req.body);
});

const standard_answer_storage = multer.diskStorage({
    destination: async function (req, file, cb) {
        await fs.promises.mkdir('answer_file/upload/', { recursive: true });
        cb(null, 'answer_file/upload/')
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname)
    }
})

const standard_answer_upload = multer({ storage: standard_answer_storage });


app.post('/upload_standard_answer', standard_answer_upload.array('files', 50), async (req, res) => {
    const homeworkName = req.body.homeworkName;
    const path_to_dir = path.join('answer_file', homeworkName);
    bin_regex = /(\.bin)$/;
    for (const file of req.files) {
        if (!bin_regex.test(file['originalname'])) {
            await transcode(file['path']);
        }
    }

    try {
        await teacher_upload.check_file('answer_file', 'upload');
    }

    catch (err) {
        await fs.promises.rm(path.join('answer_file', 'upload'), { recursive: true, force: true });
        res.send(err.message);
        return;
    }

    try {
        // 確認有沒有重複的資料夾，有的話就刪掉
        await fs.promises.readdir(path.join('answer_file', homeworkName));
        await fs.promises.rm(path.join('answer_file', homeworkName), { recursive: true, force: true });
    }

    catch (err) { }

    await fs.promises.mkdir(path_to_dir); // 建立資料夾

    const files = await fs.promises.readdir('answer_file/upload'); // 讀出upload的檔案

    for (const file of files) {
        // 全部copy到新的資料夾
        await fs.promises.copyFile(path.join('answer_file/upload', file), path.join(path_to_dir, file));
    }

    // 刪掉upload
    await fs.promises.rm(path.join('answer_file', 'upload'), { recursive: true, force: true });

    await redis.set(`current_teacher_upload_fail`, 'false', 'EX', 60 * 60 * 24 * 7);
    await teacher_upload.upload(homeworkName);
    if (await redis.get(`current_teacher_upload_fail`) === 'true') {
        await fs.promises.rm(path_to_dir, { recursive: true, force: true });

        const dependance_file_collection = client.db('dal').collection('dependance_file');
        const command_collection = client.db('dal').collection('command_file');

        await dependance_file_collection.deleteMany({ homework_name: homeworkName });
        await command_collection.deleteMany({ homework: homeworkName });

        res.send('範例程式執行錯誤，可能缺少input檔，上傳失敗');
    } else {
        res.send('upload standard answer complete');
    }

    await redis.del(`current_teacher_upload_fail`);
});

app.post('/downloadcpp', async (req, res) => {
    try {
        const upload_collection = client.db('dal').collection('upload_log');

        const filename = req.body.filename;
        const originalname = (await upload_collection.findOne({ filename: filename })).originalname;
        const studentId = (await upload_collection.findOne({ filename: filename })).upload_student;
        const homework = (await upload_collection.findOne({ filename: filename })).homework;

        const folder_name = studentId;
        const zipPath = path.join('temp', `${studentId}.zip`);

        try {
            await fs.promises.mkdir('temp');
        }
        catch (err) {
            if (err.code !== 'EEXIST') throw err;
        }

        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', {
            zlib: { level: 9 } // Sets the compression level.
        });

        output.on('close', function () {
            res.download(zipPath, `${folder_name}.zip`, (err) => {
                if (err) {
                    console.error(err);
                }

                // Delete the zip file after download
                fs.unlink(zipPath, (err) => {
                    if (err) {
                        console.error(err);
                    }
                });
            });
        });

        archive.on('error', function (err) {
            throw err;
        });

        archive.pipe(output);
        const ans_file_name = path.join('answer_file', homework);
        const files = await fs.promises.readdir(ans_file_name);
        for (var file of files) {
            // 放入所有相關檔案( .cpp除外 )
            if (path.extname(file) !== '.cpp') {
                archive.append(fs.createReadStream(path.join(ans_file_name, file)), { name: file });
            } // if()
        } // for()
        archive.append(fs.createReadStream(path.join('uploads', filename)), { name: originalname }); // 放cpp
        archive.finalize();

    } catch (err) {
        res.send(err.message + '\n');
    }
})

app.post('/downloadsamplecode', (req, res) => {
    try {
        const folder_name = req.body.folder_name;
        const folder_path = path.join('answer_file', folder_name);
        const zipPath = path.join('temp', `${folder_name}.zip`);

        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', {
            zlib: { level: 9 } // Sets the compression level.
        });

        output.on('close', function () {
            res.download(zipPath, `${folder_name}.zip`, (err) => {
                if (err) {
                    console.error(err);
                }

                // Delete the zip file after download
                fs.unlink(zipPath, (err) => {
                    if (err) {
                        console.error(err);
                    }
                });
            });
        });

        archive.on('error', function (err) {
            throw err;
        });

        archive.pipe(output);
        archive.directory(folder_path, false);
        archive.finalize();
    } catch (err) {
        res.send(err.message + '\n');
    }
});

// 刪除作業
app.post('/delete_hw', async (req, res) => {
    // 前端傳給我們作業名稱( homeworkName: string )
    const homeworkName = req.body.homeworkName;
    const dependance_file_collection = client.db('dal').collection('dependance_file');
    const command_collection = client.db('dal').collection('command_file');

    // 刪掉所有相關檔案( 除了學生程式 )
    dependance_file_collection.deleteMany({ homework_name: homeworkName });
    command_collection.deleteMany({ homework: homeworkName });

    // 刪掉該作業的所有檔案
    await fs.promises.rm(path.join('answer_file', homeworkName), { recursive: true, force: true });

    res.send('delete homework complete');
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});





const WebSocket = require('ws');
const pty = require('node-pty');
const { time } = require('console');
const { string } = require('prop-types');

async function prepare_env(filename) {
    const dependency_collection = client.db('dal').collection('dependance_file');
    const upload_collection = client.db('dal').collection('upload_log');
    // 在execute中建立一個隨機名字的資料夾
    // 以下稱呼隨機名字的資料夾為ran
    var name = uuid.v4();
    var return_path = `execute/${name}`
    var execute_path = path.join('execute', name);    // execute_path為ran的路徑
    var execute_file = path.join(execute_path, 'program');      // 所有執行檔都是program
    var compile_path = path.join('compiled', filename);
    await fs.promises.mkdir(execute_path);

    const homework = (await upload_collection.findOne({ filename: filename })).homework; // 尋找是哪一次作業

    const dependencies = await dependency_collection.find({ homework_name: homework }).toArray();
    // 將每次作業的相關檔案放到ran資料夾下
    for (const dependence of dependencies) {
        await fs.promises.writeFile(path.join(execute_path, dependence.filename), dependence.content);
    }

    // 將同學的執行檔複製到ran下
    await fs.promises.copyFile(compile_path, execute_file);

    return return_path;
}

const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
    let ptyProcess = null;
    let cwd = null;
    var token = null;
    var exit = false;

    // 設定 timeout
    let timeoutId = setTimeout(() => {
        ws.close();
    }, 300000); // 10 秒後關閉連線

    ws.on('message', async (message) => {
        if (exit) {
            ws.close();
            return;
        }

        if (!ptyProcess) {
            // 解析收到的消息
            const data = JSON.parse(message);
            const filename = data.filename;
            token = data.token;
            if (!WebSocket_auth.has(token)) {
                ws.send('Unauthorized');
                ws.close();
                return;
            }

            cwd = await prepare_env(filename);

            const upload_collection = client.db('dal').collection('upload_log');
            const result = await upload_collection.findOne({ filename: filename })

            // 初始化虛擬終端
            ptyProcess = pty.spawn('bash', ['-c', `echo -e "學號:${result.upload_student}\n" && firejail --quiet ./program`], {
                name: 'xterm-color',
                cols: 80,
                rows: 30,
                cwd: cwd,
                env: process.env
            });

            ptyProcess.on('data', (data) => {
                ws.send(data);
            });

            // 監聽ptyProcess的退出事件
            ptyProcess.on('exit', () => {
                ws.send('程式已退出');
                exit = true;
                // ws.close(); // 當ptyProcess退出時，關閉WebSocket連線
                // console.log('ptyProcess exited, WebSocket connection closed');
            });

        } else {
            // 將客戶端消息傳遞給虛擬終端
            ptyProcess.write(message);
        }
    });

    ws.on('close', async () => {
        clearTimeout(timeoutId);
        if (!WebSocket_auth.has(token)) {
            return;
        } else {
            WebSocket_auth.delete(token);
        }


        if (ptyProcess) {
            ptyProcess.kill();
        }

        // 刪除 cwd
        try {
            await fs.promises.rm(cwd, { recursive: true, force: true });
            console.log(`Deleted directory: ${cwd}`);
        } catch (error) {
            console.error(`Error deleting directory: ${cwd}`, error);
        }
    });
});