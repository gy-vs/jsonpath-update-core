# jsonpath-update-core

一个零依赖的 JSONPath 查询与**原子改写**库，TypeScript 实现，语义遵循 [RFC 9535](https://www.rfc-editor.org/rfc/rfc9535)。

适用场景：每周批量修改几百上千份服务配置，希望

- 写一条路径表达式就能**查**，也能用同一条表达式**改**；
- `update` 命中的节点和 `query` 的结果**一一对应，不多也不少**；
- 一次调用**要么全部生效，要么一处都不变**——用户函数在第 30 份配置上抛错，拿到的是原样输入和出错路径，不需要回滚；
- 传入对象绝不被原地修改，没改到的子树保持同一引用（`===`），方便精确比对。

不提供命令行入口，只作为库 import。

## 安装与测试

```bash
npm install
npm test        # vitest，含官方 RFC 9535 一致性测试套件（CTS）
npm run build   # tsc 产出 dist/，带 .d.ts
```

## 快速上手

```ts
import { query, replace, remove, transform } from 'jsonpath-update-core';

const doc = {
  servers: [
    { host: 'a.example', port: 80 },
    { host: 'b.example', port: 8080 },
    { host: 'c.example', port: 443 },
  ],
};

// 查询：每个结果带 value、规范路径 path、路径分段 keys
query(doc, '$.servers[*].host');
// [
//   { value: 'a.example', path: "$['servers'][0]['host']", keys: ['servers', 0, 'host'] },
//   ...
// ]

// 常量替换（不改原对象）
const r1 = replace(doc, '$.servers[*].port', 9000);
r1.value; // 三个 port 都变成 9000；doc 不变

// 删除：[0,2,-1] 按【原数组】位置删除，不受下标移动影响
remove(doc, '$.servers[0,2,-1]');
// servers 只剩 b.example 那一项

// 函数变换：任一命中点抛错 → 整体失败、原样返回
const r2 = transform(doc, '$.servers[*].port', (v, path) => {
  if (v === 8080) throw new Error('bad port');
  return Number(v) + 1;
});
r2.ok;      // false
r2.value;   // === doc，原样
r2.path;    // "$['servers'][1]['port']"，出错路径
r2.index;   // 1，query 结果中的下标
r2.error;   // 原始错误对象
```

也可以先 `parse()` 缓存 AST，重复执行：

```ts
import { parse } from 'jsonpath-update-core';
const ast = parse('$.servers[*].port');
query(doc, ast);
transform(doc, ast, (v) => Number(v) + 1);
```

## 支持的语法

| 写法 | 含义 |
| --- | --- |
| `$` | 根节点 |
| `.name` | 成员名简写（名字只能是字母/下划线/非 ASCII 开头，后接数字） |
| `['name']`、`["name"]` | 成员名，支持 RFC 转义：`\b \t \n \f \r \" \' \/ \\ \uXXXX`（含代理对） |
| `.*`、`[*]` | 通配：对象全部成员值 / 数组全部元素 |
| `[3]`、`[-1]` | 下标，负数从末尾倒数；越界不报错，选空 |
| `[start:end]`、`[start:end:step]` | 切片，各部分可省略；`[::0]` 合法且选空（**不会卡死**） |
| `..name`、`..[*]`、`..['a','b']` | 递归下降 |
| `[a, b, c]` | 方括号内逗号分隔的并集 |

空白（空格/制表/换行/回车）允许出现在段与段之间、括号内逗号两侧，如 `$ ['a'] , [0]`；
不允许出现在 `$` 之前、表达式末尾，或 `.`/`..` 与简写名之间。

**过滤器 `?(...)` 不实现**。出现即抛 `JSONPathSyntaxError`，错误信息附带字符位置（0 起的 `position` / 1 起的 `column`）和可视化的定位符：

```
JSONPathSyntaxError: 不支持过滤器表达式 ?(...)；...（位置 4）
  $.a[?@.x]
      ^
```

整数遵循 RFC ABNF：不允许前导零（`01`）、`-0`、`+1`、小数；绝对值 ≥ 2⁵³ 报语法错误。

## 语义约定（与 RFC 9535 对齐）

### 结果顺序

- **数组**严格按下标顺序；**对象**按自身属性枚举顺序（即 JSON 文本顺序 / 插入顺序），因此同一份数据多次运行结果完全一致。RFC 允许对象通配顺序任意，本库选择确定序。
- **递归下降**是前序 DFS：节点先于其后代被访问，数组按下标序。`..[selectors]` 对“节点自身 + 每个后代”各施加一次选择器，按访问顺序拼接。
- **切片**严格按 RFC 2.3.4.2.2 的 Normalize/Bounds 算法，特别是负步长：
  - `$[5:1:-1]` → 下标 5,4,3,2（不含 1）
  - `$[::-1]` → 完整逆序
  - 越界会被裁剪，`step = 0` 选空。
- **并集不去重**：`$[0,0]` 的结果就是两个 `$[0]`（RFC 2.5.1.2），值和路径各出现两次。

### 规范路径

每个结果都带 `path`，形如 `$['servers'][0]['host']`：方括号规范记法、单引号、
`'` 与 `\` 转义、控制字符一律 `\u00xx`（小写 hex）。负下标会被规范化（`$[-2]` 在长度为 3 的数组上路径是 `$[1]`）。

### 循环引用与别名

- 同一对象被两处引用（菱形/DAG）：两处查询都能命中，互不影响。
- 真正绕回自己祖先的环：抛 `CyclicReferenceError`（携带形成环的位置路径），查询和更新都不会死循环或爆栈。
- 全部遍历/重建均使用**显式栈迭代**，几千层嵌套安全（测试覆盖 5000 层）。

## 改写操作

三个操作签名一致，返回判别联合 `UpdateResult`：

```ts
replace(root, path, value)                       // 每个命中点替换为同一个值
transform(root, path, (value, path) => newValue) // 函数变换
remove(root, path)                               // 数组删元素 / 对象删成员 / 删根得 null

type UpdateResult =
  | { ok: true; value: unknown; changed: boolean; count: number }
  | { ok: false; value: root; changed: false; count?: never
      index: number; path: string; op: 'replace' | 'delete' | 'transform'; error: unknown };
```

约定：

1. **命中一一对应**：`count` 恒等于同表达式 `query()` 的结果数；函数会在每个命中点上执行（包括彼此嵌套的命中点），所以任意一点抛错都能触发整体失败。
2. **原子性（两阶段）**：阶段一只调用用户函数、绝不写输入；任一函数抛错立即返回 `{ ok:false, value: 原对象 }`。阶段二才基于编辑树惰性重建新树。因此失败时输入与调用前完全相同（同一引用），不存在“改了一半”。
3. **结构共享**：重建只复制“通往被改节点”路径上的容器，未命中的子树保持原引用（`===`）；新值与原值 `Object.is` 相等时视为无变化，整棵子树（乃至根）都不换引用。`changed` 即表示根引用是否发生变化。
4. **多点删除按原位置**：`remove(doc, '$.servers[0,2,-1]')` 一次性按原数组下标删除这三个位置，重复位置只删一次。
5. **嵌套命中的确定性规则——最外层命中生效**：`$..retry` 可能同时命中一个容器和它内部的同名节点。此时外层命中的编辑生效（整个子树被替换/删除），内部命中点的编辑不再单独落地；但内部命中点的函数**仍会被调用**，其抛错照样导致整次失败。该规则只取决于路径的祖先关系，与遍历顺序、命中出现的先后无关。同一位置被多个选择器重复命中（如 `$[0,0]`）时，按 query 结果顺序第一次出现的编辑生效。
6. 删除根节点（`remove(doc, '$')`）返回 `null`。

## 性能（参考）

内置基准测试（`test/perf.test.ts`，普通开发机）：

- 约 10 万节点的宽配置树，`$..count` 递归下降查询：几十毫秒；查询 + 一次 `transform`：约 100–700 ms；
- 4000 层深链：查询毫秒级；
- 10 万元素数组上的 `$[::0]`：立即返回空。

## API 导出

```ts
parse(expression: string): JSONPathQuery
query(root: unknown, path: string | JSONPathQuery): PathNode[]
replace(root: unknown, path: string | JSONPathQuery, value: unknown): UpdateResult
transform(root: unknown, path: string | JSONPathQuery, fn: (value: unknown, path: string) => unknown): UpdateResult
remove(root: unknown, path: string | JSONPathQuery): UpdateResult

class JSONPathSyntaxError extends SyntaxError { position: number; column: number; excerpt: string }
class CyclicReferenceError extends Error { path: string }

interface PathNode { value: unknown; path: string; keys: (string | number)[] }
```

## 许可

内部仓库使用。测试目录 `test/cts/*.json` 来自 [jsonpath-compliance-test-suite](https://github.com/jsonpath-standard/jsonpath-compliance-test-suite)（RFC 9535 官方一致性套件）。
