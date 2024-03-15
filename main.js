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
const redis = new Redis();

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
    // 找到所有的test_num
    const document = await upload_collection.findOne({ filename: target_file });

    const type = document.type;
    const homework = document.homework;
    const tests = await command_collection.find({ type: type, homework: homework }).toArray();

    tests.sort((a, b) => a.test_num - b.test_num);

    var test_info = await Promise.all(tests.map(async item => {
        const result = await execute_collection.findOne({ filename: target_file, type: type, homework: homework, test_num: item.test_num });

        return {
            testnum: item.test_num,
            tag: item.description,
            studentid: document.upload_student,
            percentage: result === null ? 0 : result.percentage
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
    const data = await fs.promises.readFile(path.join('uploads', filename));
    const content = data.toString();

    // 確定使用highlight.js進行語法高亮
    const result = hljs.highlight(content, { language: 'cpp' }).value;

    // 包含highlight.js的CSS樣式
    // 這裡使用的是"default"風格，你可以更換為其他風格
    const style = '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/10.7.2/styles/vs2015.min.css">';

    // 將CSS樣式和高亮後的代碼嵌入到HTML中
    const scripts = `
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/10.7.2/highlight.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlightjs-line-numbers.js/2.8.0/highlightjs-line-numbers.min.js"></script>
    <script>hljs.highlightAll(); hljs.initLineNumbersOnLoad();</script>
    `;

    // 將CSS樣式、高亮後的代碼和腳本嵌入到HTML中
    const html = `<html><head>${style}</head><body><pre><code class="hljs">${result}</code></pre>${scripts}</body></html>`;

    res.send(html);
});

app.post('/diff', async (req, res) => {
    try {
        const target_file = req.body.target_file;
        const test_num = req.body.testnum.toString();
    
        const exec_collection = client.db('dal').collection('execute_log');
        const result = await exec_collection.findOne({ filename: target_file, test_num: test_num });    // 從資料庫找出執行結果
    
        // 處理編譯錯誤
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
    
        // 計算時間
        const { performance } = require('perf_hooks');
        const start = performance.now();
        const diff = result.diff_result[0].diff_result;
        console.log('Time taken:', performance.now() - start, 'ms');
        var html = dmp.diff_prettyHtml(diff);
    
        html = html.replaceAll('background', 'color'); // 改字體顏色
        html = html.replaceAll('#e6ffe6', '#6eff6e'); // 綠色
        html = html.replaceAll('#ffe6e6', '#ef5350'); // 紅色
    
        if (result.state === 'runtime error' || result.state === 'success') {
            var error_message = result.stderr;
        } // if()
    
        else if (result.state === 'timeout') {
            var error_message = "time limit exceeded";
        } // else if()
    
        const result_html = hljs.highlight(error_message, { language: 'bash' }).value;
        const style = '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/10.7.2/styles/vs2015.min.css">';
        html = `<html><head>${style}</head>` + `<h1 style=\"font-size: 30px;\">輸出比對:</h1><br>` + html + "<br><br>" + `<pre><code>${result_html}</code></pre>`;
    
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

var uploading = false;

app.post('/upload', upload.array('files'), async (req, res) => {
    uploading = true;
    const pattern = /^\d{8}_|^補交_/;
    
    for (const file of req.files) {
        const originalname = decodeURIComponent(file.originalname);
        if (!pattern.test(originalname)) {
            res.send(`檔名格式錯誤: ${originalname}，檔名必須以學號開頭`);
            for (const cppfile of req.files) {
                fs.promises.rm(cppfile['path'], { recursive: true, force: true });
            }
            uploading = false;
            return;
        }

        else if ( originalname.split('_')[0] === "補交") {
            for ( const cppfile of req.files) {
                const cppfilename = decodeURIComponent(cppfile['originalname']);
                if ( cppfilename === originalname ) {
                    fs.promises.rm(cppfile['path'], { recursive: true, force: true });
                    req.files = req.files.filter(file => decodeURIComponent(file.originalname) !== originalname);
                }
            }
        }
    }

    var upload_id = Date.now() + '-' + uuid.v4();

    const upload_collection = client.db('dal').collection('upload_log');
    const upload_tag_collection = client.db('dal').collection('upload_tag');
    const compiled_collection = client.db('dal').collection('compiled_log');


    await upload_tag_collection.insertOne({ upload_id: upload_id, tag: req.body.tag });
    const asyncQueue = new AsyncQueue();

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

    } // for()

    const all_cpp = await upload_collection.find({ upload_id: upload_id }).toArray();

    const all_cpp_promise = []

    all_cpp.forEach(exe => {
        const filename = exe.filename; // 從資料庫找出cpp名稱
        const original = exe.originalname; // 從資料庫找出原始檔名

        all_cpp_promise.push(() => compile(filename, original))
    });

    console.log('開始編譯')
    await asyncQueue.processQueue(all_cpp_promise);
    console.log('編譯完成')

    const all_exe = await compiled_collection.find({ filename: { $in: all_cpp.map(item => item.filename) }, state: 'success' }).toArray();
    const all_exe_filename = all_exe.map(item => item.filename);
    const compiled_exe = all_cpp.filter(cpp => all_exe_filename.includes(cpp.filename))

    var all_exe_promise = []

    for (const exe of compiled_exe) {
        const filename = exe.filename; // 從資料庫找出cpp名稱
        const homework = exe.homework; // 從資料庫找出作業名稱 (第幾次作業)
        const type = exe.type; // 從資料庫找出題目類型 (作業或挑戰)
        const result = await execute(filename, homework, type)
        all_exe_promise = all_exe_promise.concat(result);
    }

    console.log('開始執行')
    await asyncQueue.processQueue(all_exe_promise);
    console.log('執行完成')

    res.send(upload_id);
    uploading = false;
});

// app.post('/upload_complete', async (req, res) => {
//     if (!(req.sessionID in upload_record)) {
//         res.send('請先上傳檔案\n');
//         return;
//     }


//     const all_cpp = await collection.find({ upload_id: upload_id }).toArray();

//     const all_cpp_promise = []

//     all_cpp.forEach(exe => {
//         const filename = exe.filename; // 從資料庫找出cpp名稱
//         const original = exe.originalname; // 從資料庫找出原始檔名

//         all_cpp_promise.push(() => compile(filename, original))
//     });

//     console.log('開始編譯')
//     await asyncQueue.processQueue(all_cpp_promise);
//     console.log('編譯完成')

//     const all_exe = await compiled_collection.find({ filename: { $in: all_cpp.map(item => item.filename) }, state: 'success' }).toArray();
//     const all_exe_filename = all_exe.map(item => item.filename);
//     const compiled_exe = all_cpp.filter(cpp => all_exe_filename.includes(cpp.filename))

//     var all_exe_promise = []

//     for (const exe of compiled_exe) {
//         const filename = exe.filename; // 從資料庫找出cpp名稱
//         const homework = exe.homework; // 從資料庫找出作業名稱 (第幾次作業)
//         const type = exe.type; // 從資料庫找出題目類型 (作業或挑戰)
//         const result = await execute(filename, homework, type)
//         all_exe_promise = all_exe_promise.concat(result);
//     }

//     console.log('開始執行')
//     await asyncQueue.processQueue(all_exe_promise);
//     console.log('執行完成')

//     res.send(upload_id);

// });

function compile(filename, originalname, upload_folder = 'uploads', compile_folder = 'compiled') {
    return new Promise((resolve, reject) => {
        const compiled_collection = client.db('dal').collection('compiled_log');
        const upload_path = path.join(upload_folder, filename);
        const compile_path = path.join(compile_folder, filename);

        // 編譯指令
        const command = `mv ${upload_path} ${upload_path}.cpp && g++ ${upload_path}.cpp -o ${compile_path}`;

        exec(command, async (error, stdout, stderr) => {
            if (error) {
                var message = error.message.replaceAll(`${upload_path}.cpp`, originalname);
            }

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


function cal_diff(output, ans) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('./diffWorker.js', { workerData: { output, ans } });

        worker.on('message', (result) => {
            resolve(result);
        });

        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code != 0)
                reject(new Error(`Worker stopped with exit code ${code}`));
        });
    });
}

async function execute(filename, homework, type, compile_folder = 'compiled', execute_folder = 'execute') {
    const execute_collection = client.db('dal').collection('execute_log');
    const command_collection = client.db('dal').collection('command_file');
    const dependency_collection = client.db('dal').collection('dependance_file');
    const compile_path = path.join(compile_folder, filename);

    // 從資料庫中所有找出command

    var commands = await command_collection.find({ homework: homework, type: type }).toArray();

    const all_command_function = []

    commands.forEach(command => {
        all_command_function.push(() => new Promise(async (resolve, reject) => {
            // console.log('正在執行: ' + filename + ' ' + command.type + ' ' + command.test_num)
            // 在execute中建立一個隨機名字的資料夾
            // 以下稱呼隨機名字的資料夾為ran
            var execute_path = path.join(execute_folder, uuid.v4());    // execute_path為ran的路徑
            var execute_file = path.join(execute_path, 'program');      // 所有執行檔都是program
            var input_file = path.join(execute_path, 'in.txt');         // 所有的command都是in.txt
            await fs.promises.mkdir(execute_path);


            const dependencies = await dependency_collection.find({ homework_name: homework }).toArray();
            // 將每次作業的相關檔案放到ran資料夾下
            for (const dependence of dependencies) {
                await fs.promises.writeFile(path.join(execute_path, dependence.filename), dependence.content);
            }

            // 將同學的執行檔複製到ran下
            await fs.promises.copyFile(compile_path, execute_file);

            // 將command寫成檔案放到ran/in.txt中
            await fs.promises.writeFile(input_file, command.content);

            // 執行command
            exec(`cd ${execute_path} && timeout ${process.env.TIME_LIMIT}s firejail --quiet ./program < in.txt`, { maxBuffer: 200 * 1024 * parseInt(process.env.MAX_BUFFER_SIZE_MULTIPLY) }, async (error, stdout, stderr) => {
                var state = 'success';

                if (error) {
                    if (error.code === 124) {
                        // 遇到無窮迴圈或timeout
                        state = 'timeout'
                        stdout = ""
                    } else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
                        state = 'Output Limit Exceeded'
                        stdout = ""
                    }

                    else {
                        // 其他錯誤
                        state = 'runtime error'
                    }
                }

                const diff_result_list = []

                const { diff_result, num_of_diff } = await cal_diff(stdout, command.stdout);

                // 比對輸出結果
                diff_result_list.push({ item: 'stdout', diff: num_of_diff, diff_result: diff_result });

                // 如果有寫檔的規定
                if (command.generated_files) {
                    var output_file = [];

                    for (const generated_file of command.generated_files) {
                        try {
                            // 有沒有特定檔名的檔案 (output${...}txt 之類的)
                            var content = await fs.promises.readFile(path.join(execute_path, generated_file.filename), 'utf-8');
                        }

                        catch (err) {
                            // 沒有的話就是null
                            var content = null;
                        }

                        output_file.push({ filename: generated_file.filename, content: content });

                        // 比對輸出結果
                        if (content !== null) {
                            diff_result_list.push({ item: generated_file.filename, diff: cal_diff(content, generated_file.content) });
                        } else {
                            diff_result_list.push({ item: generated_file.filename, diff: -1 });
                        }

                    }
                }

                // 結果寫入資料庫
                await execute_collection.insertOne({
                    uploadTime: new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }),
                    filename: filename,
                    homework: homework,
                    type: type,
                    state: state,
                    stdout: stdout,
                    ans: command.stdout,
                    ans_file: command.generated_files,
                    output_file: output_file,
                    stderr: stderr,
                    test_num: command.test_num,
                    diff_sum: (() => {
                        if (diff_result_list.some(element => element.diff === -1)) {
                            return -1;
                        } else {
                            let sum = diff_result_list.reduce((total, element) => {
                                if (element.item === 'stdout') {
                                    return total + element.diff * 1;
                                } else {
                                    return total + element.diff * 2;
                                }
                            }, 0);
                            return sum;
                        }
                    })(),
                    diff_result: diff_result_list
                });

                await fs.promises.rm(execute_path, { recursive: true, force: true });

                resolve();
            });
        }));
    });

    return all_command_function;
}

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

async function getState(filename) {
    const compiled_collection = client.db('dal').collection('compiled_log');
    const execute_collection = client.db('dal').collection('execute_log');
    const compile_result_list = await compiled_collection.find({ filename: filename }).toArray();
    const execute_result = await execute_collection.find({ filename: filename }).toArray();

    const all_result = [];

    compile_result_list.forEach(item => {
        if (item.state !== 'success') {
            all_result.push('CE');
        }

        return all_result;
    });

    execute_result.sort((a, b) => a.test_num - b.test_num);

    execute_result.forEach(item => {
        var test_state = 'null';
        if (item.state === 'timeout') {
            test_state = 'TLE';
        } else if (item.state === 'runtime error') {
            test_state = 'RE';
        }
        else if (item.state === 'Output Limit Exceeded') {
            test_state = 'OLE';
        } else {
            test_state = 'AC'
        }

        all_result.push(test_state);
    });

    return all_result;
}

async function cal_PR(filename) {
    var result = 0;
    const execute_collection = client.db('dal').collection('execute_log');
    const target_std = await execute_collection.find({ filename: filename }).toArray();

    if (target_std.length === 0) {
        // 全錯，錯的一蹋糊塗(完全沒輸出)
        result = 0;
    } // if()

    else {
        // 只取成功的結果
        var total_len = 0;
        var error_len = 0;
        for (const item of target_std) {
            var output_len = 0;
            var ans_len = 0;
            const ans = item.ans.replaceAll(/\s/g, '');
            total_len += ans.length; // 計算範例程式stdout的長度
            ans_len += ans.length;
            if (item.ans_file) {
                var ans_file = item.ans_file;
                ans_file = ans_file.replaceAll(/\s/g, '');
                total_len += ans_file.length; // 如果有檔案，就加上檔案的長度
                ans_len += ans_file.length;
            } // if()

            if (item.diff_sum !== "-1") {
                // const diff_patch = await cal_diff(item.stdout, item.ans);
                // error_len += diff_patch.num_of_diff;
                const diff_patch = levenshtein.get(item.stdout, item.ans);
                error_len += diff_patch;
                output_len += diff_patch;

                if (item.output_file) {
                    // diff_patch = await cal_diff(item.output_file, item.ans_file);
                    // error_len += diff_patch.num_of_diff;
                    diff_patch = levenshtein.get(item.output_file, item.ans_file);
                    error_len += diff_patch;
                    output_len += diff_patch;
                } // if()
            } // if()

            await execute_collection.updateOne({ filename: filename, type: item.type, test_num: item.test_num }, { $set: { percentage: ((output_len / ans_len) * 100).toFixed(2) } });
        }



        result = error_len / total_len; // 計算錯誤率
        result *= 100; // 用百分比呈現
    } // else()

    return result;

}

app.post('/hw_upload', async (req, res) => {
    if (uploading) {
        res.send('檔案上傳中，請稍後再試');
        return;
    }
    
    const target_hw = req.body.target_hw;
    const command_collection = client.db('dal').collection('command_file');
    const upload_collection = client.db('dal').collection('upload_log');
    const upload_tag_collection = client.db('dal').collection('upload_tag');

    const commandResult = await command_collection.aggregate([
        { $match: { homework: target_hw } },
        { $group: { _id: "$homework", types: { $addToSet: "$type" } } }
    ]).toArray();

    let uploads = [];
    for (let item of commandResult) {
        let homework = item._id;
        let types = item.types;
        const uploadResults = await upload_collection.aggregate([
            { $match: { homework: homework, type: { $in: types } } },
            { $group: { _id: { type: "$type", upload_id: "$upload_id" }, upload_students: { $addToSet: { upload_student: "$upload_student", filename: "$filename", upload_time: "$uploadTime" } } } },
            { $unwind: "$upload_students" },
            { $sort: { "_id.type": 1, "_id.upload_id": -1 } }
        ]).toArray();

        // 使用 Map 來組織數據
        const uploadsByType = new Map();
        await Promise.all(uploadResults.map(async (upload) => {
            const type = upload._id.type;
            const upload_id = upload._id.upload_id;
            const time = upload.upload_students.upload_time;


            if (await redis.get(`upload_tag:${upload_id}`) === null) {
                const upload_tag_result = await upload_tag_collection.findOne({ upload_id: upload_id });
                var upload_tag = upload_tag_result !== null ? upload_tag_result.tag : "";
                await redis.set(`upload_tag:${upload_id}`, upload_tag, 'EX', 60 * 60 * 24);
            } else {
                var upload_tag = await redis.get(`upload_tag:${upload_id}`);
            }

            const filename = upload.upload_students.filename;
            var state = []; // 為level紀錄
            if (await redis.get(`state:${filename}`) === null) {
                var state_list = await getState(filename);
                state = state_list;
                await redis.set(`state:${filename}`, JSON.stringify(state_list), 'EX', 60 * 60 * 24);
            } else {
                var state_list = await redis.get(`state:${filename}`);
                state_list = JSON.parse(state_list);
                state = state_list;
            }


            if (await redis.get(`PR:${filename}`) === null) {
                var results = await cal_PR(filename);
                results = results.toFixed(2);
                await redis.set(`PR:${filename}`, results, 'EX', 60 * 60 * 24);
            } else {
                var results = await redis.get(`PR:${filename}`);
            }

            if (await redis.get(`level:${filename}`) === null) {
                var level = 0;
                const test_num = state.length;
                var accuracy = 0;
                var CE = false;
                for (item of state) {
                    if (item === 'AC') {
                        accuracy += 1;
                    } else if (item === 'RE' || item === 'TLE') {
                        accuracy -= 1;
                    } else if (item === 'CE') {
                        CE = true;
                        break;
                    }
                } // for()

                if (CE) {
                    level = '0';
                } else if (accuracy === test_num) {
                    // all correct
                    level = '1';
                } else if (accuracy === -1 * test_num) {
                    // all wrong
                    level = '3';
                } else {
                    // some correct, some wrong
                    level = '2';
                } // else()

                await redis.set(`level:${filename}`, level, 'EX', 60 * 60 * 24);
            } else {
                var level = await redis.get(`level:${filename}`);
            }

            const upload_student = { ...upload.upload_students, state_list, results, level };

            if (!uploadsByType.has(type)) {
                uploadsByType.set(type, { type, uploadResult: [] });
            }
            let typeUploads = uploadsByType.get(type).uploadResult;
            if (!typeUploads.some(u => u._id === upload_id)) {
                typeUploads.push({ _id: upload_id, tag: upload_tag, time: time, upload_students: [] });
            }
            let uploadEntry = typeUploads.find(u => u._id === upload_id);
            uploadEntry.upload_students.push(upload_student);
        }));

        uploads = uploads.concat(Array.from(uploadsByType.values()));
    }

    uploads.forEach(element => {
        element.uploadResult.sort((a, b) => b._id.localeCompare(a._id));
        element.uploadResult.forEach(element => {
            element.upload_students.sort((a, b) => a.upload_student.localeCompare(b.upload_student));
        });
    })

    res.send(uploads);
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


app.post('/upload_standard_answer', standard_answer_upload.array('files', 20), async (req, res) => {
    const homeworkName = req.body.homeworkName;
    const path_to_dir = path.join('answer_file', homeworkName);
    for (const file of req.files) {
        await transcode(file['path']);
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

    try {
        await teacher_upload.upload(homeworkName);
        res.send('upload standard answer complete');
    }
    catch (err) {
        res.send(err.message);
    }
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
            await fs.promises.mkdir( 'temp' ) ;
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


app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});





const WebSocket = require('ws');
const pty = require('node-pty');
const { time } = require('console');

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