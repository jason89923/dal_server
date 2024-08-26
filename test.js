function removeReachableNodes(graph, start, visited) {
    let stack = [start];
    while (stack.length > 0) {
        let node = stack.pop();
        if (!visited.has(node)) {
            visited.add(node);
            for (let neighbor of (graph[node] || [])) {
                stack.push(neighbor);
            }
        }
    }
}

function topologicalSortWithTests(graph, testResults) {
    // 計算所有節點的入度
    let inDegree = {};
    for (let node in graph) {
        inDegree[node] = 0;
    }
    for (let node in graph) {
        for (let neighbor of graph[node]) {
            if (inDegree[neighbor] === undefined) {
                inDegree[neighbor] = 0;
            }
            inDegree[neighbor]++;
        }
    }

    // 找到所有入度為0的節點
    let queue = [];
    for (let node in inDegree) {
        if (inDegree[node] === 0) {
            queue.push(node);
        }
    }

    // 使用BFS進行拓撲排序
    let topoOrder = [];
    let visited = new Set();
    while (queue.length > 0) {
        let u = queue.shift();
        if (visited.has(u)) {
            continue;
        }
        // 檢查節點是否通過測試
        if (!testResults[u]) {
            // 移除由該節點出發的所有可達節點
            removeReachableNodes(graph, u, visited);
            continue;
        }

        topoOrder.push(u);
        for (let v of (graph[u] || [])) {
            inDegree[v]--;
            if (inDegree[v] === 0) {
                queue.push(v);
            }
        }
    }

    // 返回通過測試的節點的拓撲排序
    return topoOrder;
}

// 執行拓撲排序並移除未通過測試的節點
let topologicalOrder = topologicalSortWithTests(graph, testResults);
console.log(topologicalOrder);
