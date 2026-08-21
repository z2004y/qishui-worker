const { Buffer } = require('node:buffer')
const config = require('./config')
const { requestJson } = require('./http')
const { ValidationError, UpstreamError } = require('./errors')
const {
  requireString,
  optionalInt,
  optionalPositiveInt,
  boundedPositiveInt: boundedIdPositiveInt,
  extractTrackId,
  extractVideoId,
  extractPlaylistId,
  extractResourceIds,
} = require('./ids')
const {
  extractPlaylistsFromDiscoverMix,
  normalizePlaylistDetail,
  normalizeFeedItem,
  normalizeSearchGroups,
  normalizePlaylist,
} = require('./normalizers')
const { fetchAllowedText, extractRouterData, findAudioOption, formatSongFromAudioOption } = require('./routerData')
const { assertAllowedDownloadUrl, downloadBinary } = require('./download')
const { decryptAudioBuffer, decryptSpadeA, resolveAudioKey } = require('./audioDecryptor')
const { redactSensitiveString, safeUrlForOutput, sanitizeForExternal } = require('./redaction')

function boundedPositiveInt(value, fallback, name) {
  return boundedIdPositiveInt(value, fallback, config.maxPageSize, name)
}

function boundedDownloadBytes(value) {
  return Math.min(optionalPositiveInt(value, config.downloadMaxBytes, 'max_bytes'), config.downloadMaxBytes)
}

function optionalBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nonEmptyPlainObject(value) {
  return isPlainObject(value) && Object.keys(value).length > 0
}

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value)
}

function numberValue(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function redactedStringValue(value, secrets = []) {
  return redactSensitiveString(stringValue(value), secrets)
}

function firstHttpUrl(value, depth = 0) {
  if (!value || depth > 6) return ''
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedUrl = firstHttpUrl(item, depth + 1)
      if (nestedUrl) return nestedUrl
    }
    return ''
  }
  if (typeof value !== 'object') return ''
  for (const item of Object.values(value)) {
    const nestedUrl = firstHttpUrl(item, depth + 1)
    if (nestedUrl) return nestedUrl
  }
  return ''
}

function redactCommentTree(value, query = {}, context = {}) {
  return sanitizeForExternal(value, { secrets: accountCredentialSecrets(query, context, String(context.cookie || '').trim()) })
}

function normalizeCommentUser(item = {}, secrets = []) {
  const user = item.user || item.user_info || item.userInfo || item.author || item.comment_user || {}
  const avatar = firstHttpUrl(user.avatar_url || user.avatarUrl || user.avatar || user.avatar_thumb || user.avatarThumb || user.user_avatar || item.user_avatar || item.userAvatar || item.avatar_url)
  return {
    user_id: redactedStringValue(user.id ?? user.user_id ?? user.userId ?? user.uid ?? item.user_id ?? item.userId ?? item.uid, secrets),
    user_name: redactedStringValue(user.nickname ?? user.name ?? user.user_name ?? user.userName ?? item.user_name ?? item.userName ?? item.nickname, secrets),
    user_avatar: avatar ? safeUrlForOutput(redactSensitiveString(avatar, secrets)) : '',
  }
}

function normalizeComment(item = {}, groupId = '', secrets = []) {
  const user = normalizeCommentUser(item, secrets)
  return {
    id: redactedStringValue(item.id ?? item.comment_id ?? item.commentId ?? item.cid, secrets),
    group_id: redactedStringValue(item.group_id ?? item.groupId ?? item.item_id ?? item.itemId ?? groupId, secrets),
    user_id: user.user_id,
    user_name: user.user_name,
    user_avatar: user.user_avatar,
    content: redactedStringValue(item.content ?? item.text ?? item.comment_text ?? item.commentText, secrets),
    like_count: numberValue(item.like_count ?? item.likeCount ?? item.digg_count ?? item.diggCount ?? item.favorite_count),
    reply_count: numberValue(item.reply_count ?? item.replyCount ?? item.comment_count ?? item.commentCount),
    timestamp: numberValue(item.timestamp ?? item.create_time ?? item.createTime ?? item.create_timestamp ?? item.createAt),
    is_liked: optionalBoolean(item.is_liked ?? item.isLiked ?? item.liked ?? item.user_liked, false),
    raw: sanitizeForExternal(item, { secrets }),
  }
}

// ===== 移除的登录/个人接口曾使用的凭证相关辅助函数，仅剩 comment 的入站脱敏用 =====
function isAccountSensitiveKey(key) {
  const normalized = String(key || '').replace(/[-_]/g, '').toLowerCase()
  const exactSensitive = ['cookie', 'cookies', 'sessionid', 'session', 'requestheaders', 'authorization', 'auth', 'token', 'passport', 'sid', 'sidguard', 'sidtt', 'uidtt', 'odintt', 'passportcsrftoken', 'csrftoken']
  return exactSensitive.includes(normalized)
    || normalized.includes('cookie')
    || normalized.includes('session')
    || normalized.includes('token')
    || normalized.includes('authorization')
    || normalized.includes('passport')
    || normalized.startsWith('sid')
}

function extractSessionIdFromCookie(cookie) {
  const match = String(cookie || '').match(/(?:^|;\s*)sessionid=([^;]+)/i)
  return match ? match[1].trim() : ''
}

function collectCookieSecrets(cookie) {
  if (!cookie) return []
  const secrets = new Set()
  const parts = String(cookie).split(';')
  for (const part of parts) {
    const index = part.indexOf('=')
    if (index > 0) {
      const key = part.slice(0, index).trim()
      const value = part.slice(index + 1).trim()
      if (isAccountSensitiveKey(key) && value) secrets.add(value)
    }
  }
  return [...secrets]
}

function accountCredentialSecrets(query = {}, context = {}, cookie = '') {
  const secrets = new Set()
  const body = isPlainObject(query.body) ? query.body : {}
  const rawSessionid = query.sessionid ?? query.session_id ?? body.sessionid ?? body.session_id
  if (rawSessionid !== undefined && rawSessionid !== null) {
    const sessionid = String(rawSessionid).trim()
    if (sessionid) secrets.add(sessionid)
  }
  const contextCookie = String(context.cookie || '').trim()
  for (const secret of collectCookieSecrets(contextCookie)) secrets.add(secret)
  for (const secret of collectCookieSecrets(cookie)) secrets.add(secret)
  if (contextCookie) secrets.add(contextCookie)
  if (cookie) secrets.add(cookie)
  const cookieSessionid = extractSessionIdFromCookie(cookie)
  if (cookieSessionid) secrets.add(cookieSessionid)
  return [...secrets].filter(Boolean)
}

function normalizeLookupKey(key) {
  return String(key).replace(/[_-]/g, '').toLowerCase()
}

function findFirstByKeys(value, keys, depth = 0) {
  if (!value || depth > 8) return null
  const normalizedKeys = new Set(keys.map(normalizeLookupKey))
  if (Array.isArray(value)) {
    for (const element of value) {
      const nestedValue = findFirstByKeys(element, keys, depth + 1)
      if (nestedValue !== null && nestedValue !== undefined && nestedValue !== '') return nestedValue
    }
    return null
  }
  if (typeof value !== 'object') return null

  for (const [propertyName, propertyValue] of Object.entries(value)) {
    if (normalizedKeys.has(normalizeLookupKey(propertyName))) return propertyValue
  }
  for (const propertyValue of Object.values(value)) {
    const nestedValue = findFirstByKeys(propertyValue, keys, depth + 1)
    if (nestedValue !== null && nestedValue !== undefined && nestedValue !== '') return nestedValue
  }
  return null
}

function firstUrlFromValue(value) {
  if (!value) return ''
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : ''
  if (Array.isArray(value)) {
    for (const element of value) {
      const nestedUrl = firstUrlFromValue(element)
      if (nestedUrl) return nestedUrl
    }
    return ''
  }
  if (typeof value === 'object') {
    const urlValue = findFirstByKeys(value, ['main_url', 'backup_url', 'audio_url', 'play_url'])
    return firstUrlFromValue(urlValue)
  }
  return ''
}

function formatAudioInfo(song, includeRaw = false) {
  const raw = song.raw || {}
  const playAuth = findFirstByKeys(raw, ['play_auth', 'playAuth', 'PlayAuth'])
  const spadeA = findFirstByKeys({ playAuth, raw }, ['spade_a', 'spadeA'])
  const audioUrl = song.audio_url || firstUrlFromValue(findFirstByKeys(raw, ['video_list', 'play_info', 'audio_info', 'play_url']))
  const output = {
    track_id: String(song.track_id || ''),
    name: song.name || '',
    artists: Array.isArray(song.artists) ? song.artists : [],
    album: song.album || null,
    audio_url: audioUrl || '',
    has_audio_url: Boolean(audioUrl),
    spade_a: typeof spadeA === 'string' ? spadeA : '',
    has_spade_a: typeof spadeA === 'string' && Boolean(spadeA),
    play_auth: playAuth || null,
  }
  if (includeRaw) output.raw = raw
  return output
}

function base64ToBuffer(value, name, maxBytes) {
  const raw = requireString(value, name)
  const buffer = Buffer.from(raw, 'base64')
  if (!buffer.length) throw new ValidationError(`${name} 不是有效 base64 数据`)
  if (buffer.length > maxBytes) throw new ValidationError(`${name} 超过大小限制`, { max_bytes: maxBytes })
  return buffer
}

function shouldResolveTrackUrl(query) {
  return Boolean(query.track_id || query.id || query.share_url || extractTrackId(query.url))
}

class QishuiClient {
  constructor(options = {}) {
    this.lunaApiHost = options.lunaApiHost || config.lunaApiHost
    this.pcApiHost = options.pcApiHost || config.pcApiHost
    this.musicShareHost = options.musicShareHost || config.musicShareHost
    this.timeoutMs = options.timeoutMs || config.requestTimeoutMs
  }

  appHeaders(cookie) {
    return {
      'User-Agent': 'Luna/19.1.0 Android',
      'Content-Type': 'application/json; charset=utf-8',
      ...(cookie ? { Cookie: cookie } : {}),
    }
  }

  pcHeaders(cookie) {
    return {
      'User-Agent': 'LunaPC/3.0.0(290101097)',
      'Content-Type': 'application/json; charset=utf-8',
      ...(config.xHelios ? { 'X-Helios': config.xHelios } : {}),
      ...(config.xMedusa ? { 'X-Medusa': config.xMedusa } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    }
  }

  webHeaders(cookie) {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      ...(cookie ? { Cookie: cookie } : {}),
    }
  }

  // 火山引擎公开目录桥（汽水公开曲库，免登录）：按歌名搜歌曲（Worker 无 CORS/UA 限制）
  async searchTrack(query = {}, context = {}) {
    const keyword = requireString(query.keywords || query.keyword || query.q, 'keywords')
    const base = 'https://api-vehicle.volcengine.com/v2/search/type'
    const params = {
      keyword,
      search_type: 'music',
      search_source: 'qishui',
      limit: boundedPositiveInt(query.count || query.limit, 20, 'count'),
      real_offset: 0,
    }
    const common = { method: 'GET', query: params, timeoutMs: this.timeoutMs }
    let body = (await requestJson(base, {
      ...common,
      headers: { 'User-Agent': this.webHeaders()['User-Agent'], Accept: 'application/json,text/plain,*/*' },
    })).body
    let list = body && body.data && Array.isArray(body.data.list) ? body.data.list : []
    if (!list.length) {
      // 兜底：公开目录桥专用 UA
      body = (await requestJson(base, {
        ...common,
        headers: { 'User-Agent': 'eIsland/26.7 Qishui public catalog bridge', Accept: 'application/json,text/plain,*/*' },
      })).body
      list = body && body.data && Array.isArray(body.data.list) ? body.data.list : []
    }
    const tracks = (Array.isArray(list) ? list : [])
      .map((item) => ({
        id: String(item.item_id || ''),
        name: item.title || '',
        artists: [{ name: (item.author_info && item.author_info.name) || '' }].filter((a) => a.name),
        album: { cover_url: item.cover_url || '' },
        duration: Number(item.duration) || 0,
        detail_url: item.detail_url || '',
      }))
      .filter((t) => t.id && t.name)
    return { keyword, total: tracks.length, tracks }
  }

  downloadHeaders() {
    return {
      'User-Agent': this.webHeaders()['User-Agent'],
    }
  }

  postLuna(path, payload = {}, context = {}) {
    return requestJson(`${this.lunaApiHost}${path}`, {
      method: 'POST',
      body: payload,
      headers: this.appHeaders(context.cookie),
      timeoutMs: this.timeoutMs,
    })
  }

  getLuna(path, query = {}, context = {}) {
    return requestJson(`${this.lunaApiHost}${path}`, {
      method: 'GET',
      query,
      headers: this.webHeaders(context.cookie),
      timeoutMs: this.timeoutMs,
    })
  }

  getPc(path, query = {}, context = {}) {
    return requestJson(`${this.pcApiHost}${path}`, {
      method: 'GET',
      query,
      headers: this.pcHeaders(context.cookie),
      timeoutMs: this.timeoutMs,
    })
  }

  async discover(query = {}, context = {}) {
    const payload = {
      ...(query.first_request !== undefined ? { first_request: Boolean(query.first_request) } : {}),
      ...(query.ab_param ? { ab_param: query.ab_param } : {}),
    }
    const response = await this.postLuna('/luna/discover', payload, context)
    return response.body
  }

  async discoverMix(query = {}, context = {}) {
    const payload = {
      ...(query.block_type ? { block_type: String(query.block_type) } : {}),
      ...(query.sub_channel_id !== undefined ? { sub_channel_id: Number(query.sub_channel_id) || 0 } : {}),
      ...(query.cursor ? { cursor: String(query.cursor) } : {}),
      ...(query.count !== undefined ? { count: boundedPositiveInt(query.count, 10, 'count') } : {}),
      ...(query.session_id ? { session_id: String(query.session_id) } : {}),
      ...(query.feed_discover_extra && typeof query.feed_discover_extra === 'object' ? { feed_discover_extra: query.feed_discover_extra } : {}),
      ...(query.ab_param ? { ab_param: String(query.ab_param) } : {}),
    }
    const response = await this.postLuna('/luna/discover/mix', payload, context)
    return response.body
  }

  async recommendPlaylists(query = {}, context = {}) {
    const data = await this.discoverMix(query, context)
    return {
      playlists: extractPlaylistsFromDiscoverMix(data),
      has_more: Boolean(data?.has_more),
      next_cursor: data?.next_cursor || '',
      session_id: data?.session_id || '',
      upstream: data,
    }
  }

  async playlistDetail(query = {}, context = {}) {
    const playlistId = extractPlaylistId(query.id || query.playlist_id || query.url)
    if (!playlistId) throw new ValidationError('playlist_id 不能为空')
    const payload = {
      playlist_id: playlistId,
      ...(query.playlist_type !== undefined ? { playlist_type: Number(query.playlist_type) || 0 } : {}),
      ...(query.cursor ? { cursor: String(query.cursor) } : {}),
      ...(query.count !== undefined ? { count: optionalPositiveInt(query.count, 20, 'count') } : {}),
    }
    const response = await this.postLuna('/luna/playlist/detail', payload, context)
    return normalizePlaylistDetail(response.body)
  }

  async comment(query = {}, context = {}) {
    const groupId = requireString(firstPresent(query.group_id, query.track_id, query.id), 'group_id、track_id 或 id')
    const response = await this.getLuna('/luna/comments', {
      group_id: groupId,
      cursor: query.cursor ? String(query.cursor) : '',
      count: boundedPositiveInt(firstPresent(query.count, query.page_size, query.pagesize), 20, 'count'),
      group_type: query.group_type || 'track',
      image_strategy: query.image_strategy || 'tplv-luna-shrink:200:200',
      sort_type: query.sort_type || query.sortType || 'hot',
    }, context)
    const rawBody = response.body || {}
    const secrets = accountCredentialSecrets(query, context, String(context.cookie || '').trim())
    const body = redactCommentTree(rawBody, query, context)
    const source = Array.isArray(rawBody.comments)
      ? rawBody.comments
      : Array.isArray(rawBody.data)
        ? rawBody.data
        : Array.isArray(rawBody.comment_list)
          ? rawBody.comment_list
          : []
    const comments = source.map((item) => normalizeComment(item, groupId, secrets)).filter((item) => item.id || item.content)
    return {
      comments,
      total: Number(rawBody.total || rawBody.total_count || rawBody.count || comments.length) || comments.length,
      cursor: rawBody.cursor || rawBody.next_cursor || '',
      has_more: optionalBoolean(rawBody.has_more ?? rawBody.hasMore, false),
      upstream: body,
    }
  }

  async feedMode(query = {}, context = {}) {
    const response = await this.postLuna('/luna/feed/mode', {}, context)
    return response.body
  }

  async feedModeGuidance(query = {}, context = {}) {
    const response = await this.postLuna('/luna/feed/mode/guidance', {}, context)
    return response.body
  }

  pcSearchParams(query = {}, keyword) {
    const searchKeyword = keyword !== undefined ? keyword : requireString(query.keywords || query.keyword || query.q, 'keywords')
    const cursor = optionalInt(query.cursor || query.offset, 0, 'cursor')
    return {
      aid: '386088',
      app_name: 'luna_pc',
      region: 'cn',
      geo_region: 'cn',
      os_region: 'cn',
      sim_region: '',
      device_id: query.device_id || config.deviceId,
      cdid: '',
      iid: query.iid || config.installId,
      version_name: '3.0.0',
      version_code: '30000000',
      channel: 'official',
      build_mode: 'master',
      network_carrier: '',
      ac: 'wifi',
      tz_name: 'Asia/Shanghai',
      resolution: '',
      device_platform: 'windows',
      device_type: 'Windows',
      os_version: 'Windows 11',
      fp: query.fp || config.fp || query.device_id || config.deviceId,
      q: searchKeyword,
      cursor,
      search_id: query.search_id || '',
      search_method: query.search_method || 'input',
      debug_params: '',
      from_search_id: query.from_search_id || '',
      search_scene: query.search_scene || '',
    }
  }

  async search(query = {}, context = {}) {
    const keyword = requireString(query.keywords || query.keyword || query.q, 'keywords')
    const response = await this.getPc('/luna/pc/search/track', this.pcSearchParams(query, keyword), context)
    return response.body
  }

  async searchMixed(query = {}, context = {}) {
    const keyword = requireString(query.keywords || query.keyword || query.q, 'keywords')
    const response = await this.getPc('/luna/pc/search/mixed', this.pcSearchParams(query, keyword), context)
    const body = response.body || {}
    return {
      ...normalizeSearchGroups(body),
      source_strategy: 'pc_search_mixed',
      upstream: body,
    }
  }

  async searchPlaylists(query = {}, context = {}) {
    const keyword = requireString(query.keywords || query.keyword || query.q, 'keywords')
    try {
      const response = await this.getPc('/luna/pc/search/playlist', this.pcSearchParams(query, keyword), context)
      const body = response.body || {}
      const { playlists } = normalizeSearchGroups(body)
      return {
        playlists,
        source_strategy: 'pc_search_playlist',
        upstream: body,
      }
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error
      const mixed = await this.searchMixed(query, context)
      return {
        playlists: mixed.playlists,
        source_strategy: 'pc_search_mixed_playlist_extract',
        upstream: mixed.upstream,
      }
    }
  }

  async trackDetail(query = {}, context = {}) {
    const trackId = extractTrackId(query.id || query.track_id || query.url)
    if (!trackId) throw new ValidationError('track_id 不能为空')
    const response = await this.getPc('/luna/pc/track_v2', {
      track_id: trackId,
      media_type: query.media_type || 'track',
      queue_type: query.queue_type || '',
    }, context)
    return response.body
  }

  shareResolve(query = {}) {
    const emptyIds = { track_id: '', video_id: '', playlist_id: '' }
    if (query.track_id !== undefined && query.track_id !== null && query.track_id !== '') {
      const input = requireString(query.track_id, 'track_id')
      return {
        input,
        ids: { ...emptyIds, track_id: extractTrackId(input) },
        resource_types: ['track'],
        primary_type: 'track',
      }
    }
    if (query.playlist_id !== undefined && query.playlist_id !== null && query.playlist_id !== '') {
      const input = requireString(query.playlist_id, 'playlist_id')
      return {
        input,
        ids: { ...emptyIds, playlist_id: extractPlaylistId(input) },
        resource_types: ['playlist'],
        primary_type: 'playlist',
      }
    }
    if (query.video_id !== undefined && query.video_id !== null && query.video_id !== '') {
      const input = requireString(query.video_id, 'video_id')
      return {
        input,
        ids: { ...emptyIds, video_id: extractVideoId(input) },
        resource_types: ['video'],
        primary_type: 'video',
      }
    }

    const input = requireString(query.url || query.id, 'url 或 id')
    const ids = extractResourceIds(input)
    const resourceTypes = []
    if (ids.track_id) resourceTypes.push('track')
    if (ids.playlist_id) resourceTypes.push('playlist')
    if (ids.video_id) resourceTypes.push('video')
    return {
      input,
      ids,
      resource_types: resourceTypes,
      primary_type: resourceTypes.length > 1 ? 'ambiguous' : resourceTypes[0] || '',
    }
  }

  async h5SeoTrack(query = {}, context = {}) {
    const trackId = extractTrackId(query.id || query.track_id || query.url)
    if (!trackId) throw new ValidationError('track_id 不能为空')
    const response = await this.getLuna('/luna/h5/seo_track', {
      track_id: trackId,
      device_platform: query.device_platform || 'web',
    }, context)
    return response.body
  }

  async songDetail(query = {}, context = {}) {
    const input = requireString(query.url || query.id || query.track_id, 'url 或 track_id')
    const trackId = extractTrackId(input)
    if (trackId) {
      const h5 = await this.h5SeoTrack({ track_id: trackId }, context)
      return this.formatH5SeoTrack(h5, trackId)
    }

    const html = await fetchAllowedText(input, { headers: this.webHeaders(context.cookie), timeoutMs: this.timeoutMs })
    const routerData = extractRouterData(html)
    return formatSongFromAudioOption(findAudioOption(routerData), routerData)
  }

  formatH5SeoTrack(data, trackId) {
    const track = data?.seo_track?.track || {}
    const lyricContent = data?.lyric?.content || ''
    let videoModel = null
    if (data?.track_player?.video_model) {
      try {
        videoModel = JSON.parse(data.track_player.video_model)
      } catch (_) {
        videoModel = null
      }
    }
    const playInfo = videoModel?.video_list?.[0] || null
    return {
      track_id: String(trackId || track.id || ''),
      name: track.name || '',
      artists: Array.isArray(track.artists) ? track.artists.map((artist) => ({ id: String(artist.id || artist.user_info?.id || ''), name: artist.name || artist.user_info?.nickname || '' })) : [],
      album: track.album ? { id: String(track.album.id || ''), name: track.album.name || '' } : null,
      audio_url: playInfo?.main_url || playInfo?.backup_url || '',
      lyric: lyricContent,
      raw: data,
    }
  }

  async audioInfo(query = {}, context = {}) {
    const song = await this.songDetail(query, context)
    return formatAudioInfo(song, optionalBoolean(query.include_raw, false))
  }

  async downloadUrl(query = {}, context = {}) {
    const audioInfo = await this.audioInfo(query, context)
    if (!audioInfo.audio_url) throw new ValidationError('未解析到音频下载地址')
    const url = assertAllowedDownloadUrl(audioInfo.audio_url)
    return {
      ...audioInfo,
      audio_url: url.toString(),
    }
  }

  async decryptSpade(query = {}) {
    const hexKey = resolveAudioKey({
      spade_a: query.spade_a || query.spadeA,
      hex_key: query.hex_key || query.key,
    })
    return {
      hex_key: hexKey,
      key_byte_length: hexKey.length / 2,
      decrypted_from_spade_a: Boolean(query.spade_a || query.spadeA),
    }
  }

  async downloadFile(query = {}, context = {}) {
    let audioUrl = query.audio_url || query.download_url || ''
    if (!audioUrl && shouldResolveTrackUrl(query)) {
      const resolved = await this.downloadUrl({
        ...query,
        url: query.share_url || query.url,
      }, context)
      audioUrl = resolved.audio_url
    }
    if (!audioUrl && query.url) audioUrl = query.url
    const downloaded = await downloadBinary(requireString(audioUrl, 'url'), {
      headers: this.downloadHeaders(),
      timeoutMs: this.timeoutMs,
      maxBytes: query.max_bytes,
    })
    return {
      url: downloaded.url,
      filename: downloaded.filename,
      content_type: downloaded.content_type,
      size: downloaded.content_length,
      audio_base64: downloaded.buffer.toString('base64'),
    }
  }

  async audioDecrypt(query = {}, context = {}) {
    if (!config.enableDecrypt) throw new ValidationError('本地解密接口未启用')
    const hexKey = resolveAudioKey({
      spade_a: query.spade_a || query.spadeA,
      hex_key: query.hex_key || query.key,
    })

    let encryptedBuffer = null
    let sourceUrl = ''
    let filename = query.filename || 'audio.enc'
    if (query.audio_base64 || query.file_base64) {
      encryptedBuffer = base64ToBuffer(query.audio_base64 || query.file_base64, 'audio_base64', boundedDownloadBytes(query.max_bytes))
    } else {
      let audioUrl = query.audio_url || query.download_url || ''
      if (!audioUrl && shouldResolveTrackUrl(query)) {
        const resolved = await this.downloadUrl({
          ...query,
          url: query.share_url || query.url,
        }, context)
        audioUrl = resolved.audio_url
      }
      if (!audioUrl && query.url) audioUrl = query.url
      const downloaded = await downloadBinary(requireString(audioUrl, 'url'), {
        headers: this.downloadHeaders(),
        timeoutMs: this.timeoutMs,
        maxBytes: query.max_bytes,
      })
      encryptedBuffer = downloaded.buffer
      sourceUrl = downloaded.url
      filename = downloaded.filename
    }

    const decrypted = await decryptAudioBuffer(encryptedBuffer, hexKey)
    const returnBase64 = optionalBoolean(query.return_base64, true)
    return {
      source_url: sourceUrl,
      filename: filename.replace(/\.(mp4|m4a|encv|enca|bin)$/i, '') + decrypted.extension,
      content_type: decrypted.content_type,
      codec: decrypted.codec,
      sample_count: decrypted.sample_count,
      size: decrypted.buffer.length,
      audio_base64: returnBase64 ? decrypted.buffer.toString('base64') : '',
    }
  }

  async lyric(query = {}, context = {}) {
    const song = await this.songDetail(query, context)
    if (song.lyrics) return song.lyrics
    const content = song.lyric || song.raw?.lyric?.content || ''
    return {
      lrc: content,
      lines: [],
      raw: song.raw || {},
    }
  }
}

module.exports = {
  QishuiClient,
}