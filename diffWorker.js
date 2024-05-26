const { parentPort, workerData } = require('worker_threads');
const DiffMatchPatch = require('diff-match-patch');
const dmp = new DiffMatchPatch();

dmp.Diff_Timeout = 10;
const { output, ans } = workerData;

const diff_result = dmp.diff_main(ans, output);
dmp.diff_cleanupSemantic(diff_result);

const num_of_diff = diff_result.filter(item => item[0] !== 0).length;

parentPort.postMessage({ diff_result, num_of_diff });