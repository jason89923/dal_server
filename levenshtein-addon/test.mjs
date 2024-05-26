import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const levenshtein = require('./build/Release/levenshtein');

const str1 = '非常長的字串1';
const str2 = '非常長的字串2';

const distance = levenshtein.levenshteinDistance(str1, str2, true);
console.log(`Levenshtein distance: ${distance}`);
