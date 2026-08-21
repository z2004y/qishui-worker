#!/usr/bin/env node
/**
 * 页面 ↔ API 契约验证：模拟 qishui-browser.html 的调用路径，
 * 核对页面读取的每个字段与线上 Worker 实际返回结构一致。
 */
const W = 'https://qishui-api.zzy721683736.workers.dev'
const KEY = '721683736' // 测试专用；页面本身不带钥匙，仅 URL ?key= / 输入框

// 本机直连受限，Node fetch 显式走系统代理（页面在真实浏览器里无此问题）
const { setGlobalDispatcher, ProxyAgent } = require('undici')
const proxy = process.env.HTTPS_PROXY || process.env.http_proxy || ''
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy))

let pass = 0, fail = 0
const ok = (n) => { pass++; console.log(`✅ ${n}`) }
const bad = (n, d) => { fail++; console.log(`❌ ${n}: ${d}`) }

async function api(path, params = {}) {
  const url = new URL(W + path)
  Object.entries(params).forEach(([k, v]) => v != null && v !== '' && url.searchParams.set(k, v))
  url.searchParams.set('key', KEY) // 页面同款：?key= 传鉴权（无自定义头，避免 CORS 预检）
  const res = await fetch(url)
  const body = await res.json()
  if (res.status === 401) throw new Error('鉴权失败 401')
  if (!body || body.code !== 0) throw new Error((body && body.message) || `HTTP ${res.status}`)
  return body.data
}

;(async () => {
  try {
    // 歌曲搜索（公开目录桥，页面新 Tab）
    try {
      const st = await api('/search/track', { keywords: '小半' })
      if (Array.isArray(st.tracks) && st.tracks.length) {
        const t = st.tracks[0]
        const stOk = t.id && t.name && Array.isArray(t.artists) && typeof (t.album && t.album.cover_url) === 'string'
        stOk ? ok(`歌曲搜索（${st.tracks.length} 首）: 《${t.name}》${(t.artists || []).map((a) => a.name).join('/')} id=${t.id} 封面=${!!t.album.cover_url}`)
          : bad('歌曲搜索字段', JSON.stringify({ id: t.id, name: t.name, artists: t.artists, cover: t.album && t.album.cover_url }))
      } else bad('歌曲搜索', 'tracks 为空')
    } catch (e) { bad('歌曲搜索', e.message) }

    // 推荐歌单（页面首页 grid）
    const r = await api('/recommend/playlist', { count: 30 })
    if (!Array.isArray(r.playlists) || !r.playlists.length) return bad('推荐歌单', 'playlists 为空')
    const p0 = r.playlists[0]
    const need = [p0.id, p0.title, p0.cover_url]
    if (need.every(Boolean)) ok(`推荐歌单（${r.playlists.length} 个）: ${p0.title} / cover=${p0.cover_url.slice(0, 30)}…`)
    else bad('推荐歌单字段', JSON.stringify({ id: p0.id, title: p0.title, cover: p0.cover_url }))

    // 歌单搜索
    const s = await api('/search/playlist', { keywords: '周杰伦' })
    if (Array.isArray(s.playlists) && s.playlists.length) ok(`歌单搜索（${s.playlists.length} 个）: ${s.playlists[0].title}`)
    else bad('歌单搜索', 'playlists 为空')

    // 歌单详情（列表页读取 track 字段；某些歌单为空壳，遍历找有歌的）
    const targets = r.playlists.slice(0, 6)
    let d = null, pid = '', emptyCount = 0
    for (const p of targets) {
      const dd = await api('/playlist/detail', { playlist_id: p.id, count: 30 })
      const trs = (dd.media_resources || []).map((x) => x.track || x).filter(Boolean)
      if (trs.length) { d = dd; pid = p.id; break }
      emptyCount += 1
    }
    if (!d) return bad('歌单详情', `遍历 ${targets.length} 个歌单均无歌曲（${emptyCount} 个空壳）`)
    const pl = d.playlist || {}
    const tracks = (d.media_resources || []).map((x) => x.track || x).filter(Boolean)
    const t0 = tracks[0]
    const tName = t0.name || t0.title
    const tArtist = Array.isArray(t0.artists) ? t0.artists.map((a) => a.name).filter(Boolean).join('/') : (t0.artist || '')
    const tCover = t0.album ? (t0.album.cover_url || t0.album.url_cover || '') : ''
    const ok1 = tName && (t0.duration !== undefined || t0.duration_ms !== undefined)
    const listItem = { id: t0.id, title: tName, artist: tArtist, coverIsStr: typeof tCover === 'string', dur: t0.duration || Math.round((t0.duration_ms || 0) / 1000) }
    ok1 ? ok(`歌单详情（跳过 ${emptyCount} 个空壳）《${pl.title}》 ${tracks.length} 首: 《${tName}》${tArtist} 封面=${listItem.coverIsStr} 时长=${listItem.dur}s`)
      : bad('歌单详情 track 字段', JSON.stringify(listItem))

    // 电台接口已删除（上游需登录态），应 404
    try {
      await api('/radio/list')
      bad('电台接口', '应 404 却返回数据')
    } catch (e) {
      if (/接口不存在|404/.test(e.message)) ok('电台接口已删除（上游需登录态，返回 404）')
      else bad('电台接口 404 断言', e.message)
    }

    // 歌曲解析 + 播放 + 歌词（页面 footer 面板路径）
    const tid = t0.id
    const sd = await api('/song/detail', { track_id: tid })
    const coverStr = typeof (sd.album && (sd.album.cover_url || sd.album.url_cover))
    const rawCoverOk = !!(sd.raw && sd.raw.seo_track && sd.raw.seo_track.track && sd.raw.seo_track.track.album &&
      Object.keys(sd.raw.seo_track.track.album.url_cover || {}).length)
    const sdOk = sd.name && /^https:\/\//.test(sd.audio_url || '')
    sdOk ? ok(`歌曲解析: 《${sd.name}》 audio_url=${sd.audio_url.slice(0, 45)}… album.cover=${coverStr} rawCover=${rawCoverOk}`) : bad('song/detail', JSON.stringify({ name: sd.name, url: (sd.audio_url || '').slice(0, 40), cover: coverStr }))

    const ly = await api('/lyric', { track_id: tid })
    if (typeof ly.lrc === 'string') ok(`歌词 ${ly.lrc.length ? ly.lrc.length + ' 字符（KRC，页面内置转换器转 LRC）' : '为空（该歌无歌词，属正常）'}`)
    else bad('lyric', 'lrc 缺失')
  } catch (e) { bad('契约验证', e.message) }

  console.log(`\n结果: pass=${pass} fail=${fail}`)
  process.exit(fail ? 1 : 0)
})()