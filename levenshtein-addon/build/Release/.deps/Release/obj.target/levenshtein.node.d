cmd_Release/obj.target/levenshtein.node := g++ -o Release/obj.target/levenshtein.node -shared -pthread -rdynamic -m64  -Wl,-soname=levenshtein.node -Wl,--start-group Release/obj.target/levenshtein/levenshtein.o Release/obj.target/node_modules/node-addon-api/nothing.a -Wl,--end-group 
