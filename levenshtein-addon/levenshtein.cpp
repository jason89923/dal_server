#include <napi.h>
#include <string>
#include <vector>
#include <locale>
#include <codecvt>
#include <algorithm>

class Levenshtein {
public:
    static int get(const std::wstring& str1, const std::wstring& str2, bool useCollator = false) {
        if (useCollator) {
            return getWithCollator(str1, str2);
        } else {
            return getWithoutCollator(str1, str2);
        }
    }

private:
    static int getWithCollator(const std::wstring& str1, const std::wstring& str2) {
        size_t str1Len = str1.length();
        size_t str2Len = str2.length();

        if (str1Len == 0) return str2Len;
        if (str2Len == 0) return str1Len;

        std::vector<int> prevRow(str2Len + 1, 0);
        std::vector<int> str2Char(str2Len);

        for (size_t i = 0; i < str2Len; ++i) {
            prevRow[i] = i;
            str2Char[i] = str2[i];
        }
        prevRow[str2Len] = str2Len;

        for (size_t i = 0; i < str1Len; ++i) {
            int nextCol = i + 1;

            for (size_t j = 0; j < str2Len; ++j) {
                int curCol = nextCol;

                bool strCmp = (str1[i] == str2[j]);
                nextCol = prevRow[j] + (strCmp ? 0 : 1);

                nextCol = std::min(nextCol, curCol + 1);
                nextCol = std::min(nextCol, prevRow[j + 1] + 1);

                prevRow[j] = curCol;
            }

            prevRow[str2Len] = nextCol;
        }
        return prevRow[str2Len];
    }

    static int getWithoutCollator(const std::wstring& str1, const std::wstring& str2) {
        size_t str1Len = str1.length();
        size_t str2Len = str2.length();

        if (str1Len == 0) return str2Len;
        if (str2Len == 0) return str1Len;

        std::vector<int> prevRow(str2Len + 1, 0);
        for (size_t i = 0; i <= str2Len; ++i) {
            prevRow[i] = i;
        }

        for (size_t i = 0; i < str1Len; ++i) {
            int nextCol = i + 1;

            for (size_t j = 0; j < str2Len; ++j) {
                int curCol = nextCol;
                nextCol = prevRow[j] + (str1[i] == str2[j] ? 0 : 1);
                nextCol = std::min(nextCol, curCol + 1);
                nextCol = std::min(nextCol, prevRow[j + 1] + 1);
                prevRow[j] = curCol;
            }
            prevRow[str2Len] = nextCol;
        }
        return prevRow[str2Len];
    }
};

Napi::Value LevenshteinDistance(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "String expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string str1 = info[0].As<Napi::String>();
    std::string str2 = info[1].As<Napi::String>();
    bool useCollator = info.Length() > 2 ? info[2].As<Napi::Boolean>() : false;

    std::wstring_convert<std::codecvt_utf8_utf16<wchar_t>> converter;
    std::wstring wstr1 = converter.from_bytes(str1);
    std::wstring wstr2 = converter.from_bytes(str2);

    int distance = Levenshtein::get(wstr1, wstr2, useCollator);

    return Napi::Number::New(env, distance);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "levenshteinDistance"), Napi::Function::New(env, LevenshteinDistance));
    return exports;
}

NODE_API_MODULE(levenshtein, Init)
