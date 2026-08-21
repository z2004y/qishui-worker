// 静态路由注册表（替代原 server.js 的 fs.readdir + require 动态扫描）
// key = 模块文件名（去 .js），路由为 /key 且下划线转斜杠，可用 module 上的 route 覆盖
//
// 已移除的登录/个人接口（auth:true 或 app_context:true，或登录链路本身）：
//   /auth/qrcode /auth/qrcode/status /auth/me /me/playlists /me/collection/mixed
//   /video/detail /media/player /daily/mix /playlist/feed/media /playlist/related/media /feed/listen/video
module.exports = {
  api_capabilities: require('../module/api_capabilities'),
  audio_decrypt: require('../module/audio_decrypt'),
  audio_info: require('../module/audio_info'),
  comment: require('../module/comment'),
  decrypt_spade: require('../module/decrypt_spade'),
  discover: require('../module/discover'),
  discover_mix: require('../module/discover_mix'),
  download_file: require('../module/download_file'),
  download_url: require('../module/download_url'),
  feed_mode: require('../module/feed_mode'),
  feed_mode_guidance: require('../module/feed_mode_guidance'),
  h5_seo_track: require('../module/h5_seo_track'),
  lyric: require('../module/lyric'),
  playlist_detail: require('../module/playlist_detail'),
  radio_list: require('../module/radio_list'),
  radio_tracks: require('../module/radio_tracks'),
  recommend_playlist: require('../module/recommend_playlist'),
  search: require('../module/search'),
  search_mixed: require('../module/search_mixed'),
  search_playlist: require('../module/search_playlist'),
  share_resolve: require('../module/share_resolve'),
  song_detail: require('../module/song_detail'),
  track_detail: require('../module/track_detail'),
}