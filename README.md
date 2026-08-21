# qishui-api · Cloudflare Workers 版（公开免登录接口）

汽水音乐 API 的 Cloudflare Workers 部署，**仅保留免登录公开接口**，全部接口（除健康检查外）需携带 API Key 鉴权，防止被他人滥用。

GitHub：https://github.com/z2004y/qishui-worker

## 项目结构

```
qishui-worker/
├── src/                      # 平台无关的业务实现（Worker 兼容 JS）
│   ├── worker.mjs            # ★ 入口：fetch handler + 鉴权 + 路由分发 + CORS + body 限长
│   ├── routes.js             # 静态路由注册表（23 个公开接口；已删的登录接口不在此）
│   ├── config.js             # 配置（读 process.env，Worker 环境变量/密钥注入）
│   ├── qishuiClient.js       # 上游客户端（已裁剪：仅保留在用接口对应方法）
│   ├── capabilities.js       # 能力矩阵（与 routes.js 一一对应）
│   ├── errors.js / response.js      # 错误类型 / 统一响应 {code,message,data,trace_id}
│   ├── ids.js / lyrics.js    # ID 提取 / 歌词格式化（纯函数）
│   ├── normalizers.js        # 上游响应归一化（纯函数）
│   ├── redaction.js          # 脱敏（凭证/播放敏感字段）
│   ├── http.js               # fetch 封装（超时/JSON/错误详情脱敏）
│   ├── routerData.js         # 分享页 _ROUTER_DATA 解析（HTML 抓取）
│   ├── download.js           # 受控下载（域名白名单 + 大小限制 + 重定向跟随）
│   └── audioDecryptor.js     # spade_a 解密 + MP4 样本级 AES-CTR 解密（WebCrypto）
├── module/                   # 23 个薄路由包装（每个 = 1 个接口，参数直透 client）
├── test/
│   └── worker-test.js        # 21 项本地测试（真实上游 + 鉴权 + 404 + AES-CTR 一致性）
├── wrangler.toml             # CF 配置：compat 标志、[vars] 环境变量（含 API_KEY）
├── package.json / package-lock.json
└── README.md
```

分层：`worker.mjs`（边缘层）→ `module/*`（路由层）→ `qishuiClient`（上游客户端）→ `src/*`（纯函数工具）。除入口外全部为 CommonJS，避免改动上游移植文件；`audioDecryptor` 用 WebCrypto 替代 Node crypto，其余仅做了 `node:` 导入规范化。

## 服务地址与鉴权

**地址**：`https://qishui-api.zzy721683736.workers.dev`

**API Key**：`YOUR_API_KEY`（通过 Cloudflare Secret 注入，**不存储在仓库中**）

三种传 Key 方式（任选其一）：

```bash
# 方式一：X-API-Key 请求头（推荐，不会进 URL/日志）
curl -H "X-API-Key: YOUR_API_KEY" https://qishui-api.zzy721683736.workers.dev/song/detail?track_id=7079108541549643812

# 方式二：?key= 查询参数（脚本简单拼接方便）
curl "https://qishui-api.zzy721683736.workers.dev/song/detail?track_id=7079108541549643812&key=YOUR_API_KEY"

# 方式三：Authorization: Bearer
curl -H "Authorization: Bearer YOUR_API_KEY" https://qishui-api.zzy721683736.workers.dev/lyric?track_id=7079108541549643812
```

未携带 / 携带错误 Key → `HTTP 401`：
```json
{ "code": 40100, "message": "未授权：请在 X-API-Key 头 / ?key= 参数 / Authorization Bearer 中提供正确密钥", "data": null, "trace_id": "..." }
```

**例外**：`GET /health` 与 `OPTIONS`（CORS 预检）免鉴权。

## 接口清单（23 个，均为免登录公开接口）

### 音乐解析（核心，实测可用）
| 接口 | 说明 |
|---|---|
| `GET/POST /song/detail` | 歌曲详情或分享页解析：`track_id` / 分享链接 → 歌名、歌手、播放地址、歌词 |
| `GET/POST /audio/info` | 音频信息摘要（播放地址、spade_a、PlayAuth 是否存在） |
| `GET/POST /download/url` | 解析曲目音频地址（域名白名单校验） |
| `GET/POST /lyric` | 歌词（LRC/逐字） |
| `GET/POST /h5/seo/track` | H5 SEO 曲目详情（song/detail 内部同源） |
| `POST /audio/decrypt` | 解密加密音频（需 `spade_a`/`hex_key` + `audio_base64`/`audio_url`） |
| `POST /download/file` | 受控域名内下载音频，返回 base64 |
| `POST /decrypt/spade` | `spade_a` → 32 位 hex AES key |

### 歌单 / 推荐 / 电台
| 接口 | 说明 |
|---|---|
| `GET/POST /recommend/playlist` | 推荐歌单（实测 10 个） |
| `GET/POST /playlist/detail` | 歌单详情与媒体资源 |
| `GET/POST /discover` | 发现页块 |
| `GET/POST /discover/mix` | 发现页混合推荐流 |
| `GET/POST /feed/mode` | Feed 模式数据（对普通调用价值有限） |
| `GET/POST /feed/mode/guidance` | Feed 模式引导（同上） |
|  `GET/POST /radio/tracks` | 电台歌曲 Feed |
|  `GET/POST /radio/list` | 电台列表（上游需登录态，当前返回空） |
| `GET/POST /comment` | 歌曲评论（可能为空） |

### 搜索（⚠️ 当前上游受限，可能返回空）
| 接口 | 说明 |
|---|---|
| `GET/POST /search` | PC 搜索歌曲（2026-08 起上游要求签名，返回空 `{}`） |
| `GET/POST /search/mixed` | PC 混合搜索（上游报 `ERR_INVALID_PARAM`，返回空） |
| `GET/POST /search/playlist` | **PC 歌单搜索（实测可用，20 个结果）** |
| `GET/POST /track/detail` | PC 曲目详情（同 /search，可能返回空） |

### 工具
| 接口 | 说明 |
|---|---|
| `GET/POST /share/resolve` | 分享链接/ID 资源识别（track/video/playlist） |
| `GET /api/capabilities` | 能力矩阵 |

## 已移除的接口（需登录 / App 上下文 / 登录链路本身）

以下接口已从部署中删除（访问返回 404），因为它们只对登录用户/App 上下文有意义：

```
/auth/qrcode  /auth/qrcode/status  /auth/me  /me/playlists  /me/collection/mixed
/video/detail  /media/player  /daily/mix
/playlist/feed/media  /playlist/related/media  /feed/listen/video
```

> 需要登录态（个人歌单、收藏、播放高音质）的话，请自建 Node 版 `qishui-api`（需要扫码登录 + 持 cookie），Worker 版定位为免登录公开查询。

## 部署 / 更新

```bash
npm i
npx wrangler login
printf '你的密钥' | npx wrangler secret put API_KEY   # ★ 第一步：设置密钥（存为 Secret，不进仓库）
npx wrangler deploy          # 部署或更新
```

**`API_KEY` 是必配项**——不配置则 Worker 关闭鉴权（仅建议本地调试时如此）。修改密钥：重新 `secret put API_KEY` 或 Dashboard → Settings → Variables → Secrets 修改。本地开发可把密钥写进 `.dev.vars`（已被 gitignore，`wrangler dev` 自动读取）。

> 注意：`wrangler.toml` 中已**不留任何明文密钥**（GitHub 公开仓库安全）。若曾把密钥放 `[vars]`，先删掉再部署，否则 `secret put` 会报 `Binding name already in use`。

## 套餐 / 配额提示

| 场景 | 免费版（10ms CPU/次） | 说明 |
|---|---|---|
| 歌曲/歌单/歌词/播放地址等 JSON 接口 | ✅ 够用 | 每次 1-2 次上游 fetch（等待不计 CPU） |
| `/download/file`、`/audio/decrypt`（50MB 下载+解密） | ⚠️ 建议付费版 | 重 CPU/内存操作 |
| 其他免费限额 | 100k 请求/天、50 次 subrequest/次 | 个人使用富余 |

## 本地测试

```bash
npm test     # 21 项：真实上游 + 鉴权 + 已移除接口 404 + AES-CTR 一致性
npx wrangler dev --local   # 真实 workerd 本地跑
```

## 与 LX 音源的关系

`qishui-lx-source/`（同目录平级交付物）是免登录自包含音源，**直连上游、不经过本 Worker**，日常听歌用它即可。本 Worker 适合：
- 需要固定 API 域名 / 跨设备 / 给脚本和其他客户端统一入口
- 调用歌单、歌词等公开能力而不用在本机装 Node

## 免责声明

仅供个人学习交流使用；商用、批量抓取、版权规避等风险由使用者自行承担。