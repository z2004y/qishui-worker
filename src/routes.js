/**
 * 路由数据表（单一数据源：路由 ↔ client 方法 ↔ 能力描述）
 * - fn：QishuiClient 方法名（shareResolve 为同步方法，统一 await 调用）
 * - methods：允许的 HTTP 方法（默认 get/post）
 * - bodyOnly：敏感参数必须放 POST body（GET 带查询参数直接 400）
 * - /api/capabilities 由本表在 worker.mjs 内联生成（加自身共 22 项）
 *
 * 已移除的登录/个人接口（auth/app_context）：
 *   /auth/* /me/* /video/detail /media/player /daily/mix
 *   /playlist/feed/media /playlist/related/media /feed/listen/video /radio/*
 */
module.exports = [
  { fn: 'recommendPlaylists', route: '/recommend/playlist', desc: '推荐歌单', group: 'playlist' },
  { fn: 'playlistDetail', route: '/playlist/detail', desc: '歌单详情与媒体资源', group: 'playlist' },
  { fn: 'discover', route: '/discover', desc: '发现页块', group: 'feed' },
  { fn: 'discoverMix', route: '/discover/mix', desc: '发现页混合推荐流', group: 'feed' },
  { fn: 'feedMode', route: '/feed/mode', desc: 'Feed 模式数据', group: 'feed' },
  { fn: 'feedModeGuidance', route: '/feed/mode/guidance', desc: 'Feed 模式引导', group: 'feed' },
  { fn: 'comment', route: '/comment', desc: '歌曲评论列表（可能为空）', group: 'comment' },
  { fn: 'search', route: '/search', desc: 'PC 搜索歌曲（当前上游受限，可能返回空）', group: 'search' },
  { fn: 'searchPlaylists', route: '/search/playlist', desc: 'PC 搜索歌单或从混合搜索提取歌单', group: 'search' },
  { fn: 'searchMixed', route: '/search/mixed', desc: 'PC 混合搜索（当前上游受限，可能返回空）', group: 'search' },
  { fn: 'searchTrack', route: '/search/track', desc: '公开目录按歌名搜歌曲（火山桥，免登录）', group: 'search' },
  { fn: 'trackDetail', route: '/track/detail', desc: 'PC 曲目详情（当前上游受限，可能返回空）', group: 'media' },
  { fn: 'h5SeoTrack', route: '/h5/seo/track', desc: 'H5 SEO 曲目详情', group: 'media' },
  { fn: 'songDetail', route: '/song/detail', desc: '歌曲详情或分享页解析', group: 'share' },
  { fn: 'lyric', route: '/lyric', desc: '歌词解析', group: 'share' },
  { fn: 'shareResolve', route: '/share/resolve', desc: '分享链接资源识别', group: 'share' },
  { fn: 'audioInfo', route: '/audio/info', desc: '音频信息摘要', group: 'audio' },
  { fn: 'downloadUrl', route: '/download/url', desc: '解析曲目音频地址', group: 'audio' },
  { fn: 'downloadFile', route: '/download/file', methods: ['post'], bodyOnly: true, desc: '受控下载音频文件', group: 'audio' },
  { fn: 'decryptSpade', route: '/decrypt/spade', methods: ['post'], bodyOnly: true, desc: '解密受控音频令牌', group: 'audio' },
  { fn: 'audioDecrypt', route: '/audio/decrypt', methods: ['post'], bodyOnly: true, desc: '本地解密加密音频', group: 'audio' },
]