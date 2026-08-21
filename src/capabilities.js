// 能力矩阵：仅保留免登录公开接口（auth:false 且 app_context:false）
const capabilities = [
  { group: 'search', route: '/search', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: 'PC 搜索歌曲（当前上游受限，可能返回空）' },
  { group: 'search', route: '/search/playlist', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: 'PC 搜索歌单或从混合搜索提取歌单' },
  { group: 'search', route: '/search/track', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: '公开目录按歌名搜歌曲（火山桥，免登录）' },
  { group: 'search', route: '/search/mixed', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: 'PC 混合搜索（当前上游受限，可能返回空）' },
  { group: 'playlist', route: '/recommend/playlist', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: '推荐歌单' },
  { group: 'playlist', route: '/playlist/detail', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: '歌单详情与媒体资源' },
  { group: 'feed', route: '/discover', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: '发现页块' },
  { group: 'feed', route: '/discover/mix', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: '发现页混合推荐流' },
  { group: 'feed', route: '/feed/mode', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: 'Feed 模式数据' },
  { group: 'feed', route: '/feed/mode/guidance', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: 'Feed 模式引导' },
  { group: 'media', route: '/track/detail', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: 'PC 曲目详情（当前上游受限，可能返回空）' },
  { group: 'media', route: '/h5/seo/track', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: 'H5 SEO 曲目详情' },
  { group: 'comment', route: '/comment', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: '歌曲评论列表（可能为空）' },
  { group: 'share', route: '/song/detail', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: '歌曲详情或分享页解析' },
  { group: 'share', route: '/lyric', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: '歌词解析' },
  { group: 'share', route: '/share/resolve', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: '分享链接资源识别' },
  { group: 'audio', route: '/audio/info', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: '音频信息摘要' },
  { group: 'audio', route: '/download/url', methods: ['GET', 'POST'], auth: false, app_context: false, raw: true, description: '解析曲目音频地址' },
  { group: 'audio', route: '/download/file', methods: ['POST'], auth: false, app_context: false, raw: false, description: '受控下载音频文件' },
  { group: 'audio', route: '/decrypt/spade', methods: ['POST'], auth: false, app_context: false, raw: false, description: '解密受控音频令牌' },
  { group: 'audio', route: '/audio/decrypt', methods: ['POST'], auth: false, app_context: false, raw: false, description: '本地解密加密音频' },
  { group: 'system', route: '/api/capabilities', methods: ['GET'], auth: false, app_context: false, raw: false, description: '能力矩阵' },
]

module.exports = { capabilities }