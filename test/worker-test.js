#!/usr/bin/env node
/**
 * qishui-worker 本地测试
 * Node >= 19（全局 fetch / crypto.subtle）即可运行，不需要真实 Worker 环境：
 *   node test/worker-test.js
 * 会真实请求上游接口 + 验证 WebCrypto AES-CTR 与 Node crypto 行为一致。
 */
const assert = require('assert')
const nodeCrypto = require('crypto')
const path = require('path')
const { pathToFileURL } = require('url')
const { decryptCtr } = require('../src/audioDecryptor')
let worker

const BASE = 'http://localhost'
let pass = 0
let fail = 0

function ok(name) {
  pass += 1
  console.log(`✅ ${name}`)
}
function bad(name, detail) {
  fail += 1
  console.log(`❌ ${name}: ${detail}`)
}

async function api(path, init, env = {}) {
  const res = await worker.fetch(new Request(BASE + path, init), env)
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch (_) {}
  return { status: res.status, body, text }
}

;(async () => {
  worker = (await import(pathToFileURL(path.join(__dirname, '../src/worker.mjs')).href)).default

  // 0) AES-CTR 一致性
  try {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const iv = Buffer.alloc(16)
    iv.writeUInt32BE(0x01020304, 0)
    iv.writeUInt32BE(0x05060708, 4)
    const plain = Buffer.concat([Buffer.from('hello-qishui-worker-'), Buffer.alloc(97, 0xab)])
    const cipher = nodeCrypto.createCipheriv('aes-128-ctr', key, iv)
    cipher.setAutoPadding(false)
    const enc = Buffer.concat([cipher.update(plain), cipher.final()])
    const dec = await decryptCtr(enc, key, new Uint8Array(iv))
    assert(dec.equals(plain), '解密结果不一致')
    ok('AES-CTR: WebCrypto 与 Node crypto 解密一致（aes-128-ctr 行为等价）')
  } catch (e) {
    bad('AES-CTR 一致性', e.message)
  }

  // 1) 基础路由
  try {
    const r = await api('/health')
    assert(r.status === 200 && r.body.code === 0 && r.body.data.status === 'ok')
    ok('GET /health')
  } catch (e) { bad('GET /health', e.message) }

  try {
    const r = await api('/')
    assert(r.status === 200 && Array.isArray(r.body.data.routes) && r.body.data.routes.includes('/song/detail'))
    ok(`GET / 路由列表（${r.body.data.routes.length} 个）`)
  } catch (e) { bad('GET /', e.message) }

  try {
    const r = await api('/no/such/route')
    assert(r.status === 404 && r.body.code === 40400)
    ok('GET /no/such/route -> 404')
  } catch (e) { bad('404 路由', e.message) }

  try {
    const r = await worker.fetch(new Request(BASE + '/health', { method: 'OPTIONS' }), {})
    assert(r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === '*')
    ok('OPTIONS CORS (204, ACAO=*)')
  } catch (e) { bad('OPTIONS', e.message) }

  // 2) /api/capabilities
  try {
    const r = await api('/api/capabilities')
    assert(r.status === 200 && r.body.data.count > 10 && Array.isArray(r.body.data.capabilities))
    ok(`GET /api/capabilities（${r.body.data.count} 项）`)
  } catch (e) { bad('/api/capabilities', e.message) }

  // 3) song_detail（H5 SEO，直接播放地址 + KRC 歌词）
  try {
    const r = await api('/song/detail?track_id=7079108541549643812')
    assert(r.status === 200 && r.body.code === 0, `code=${r.body && r.body.code}`)
    const d = r.body.data
    assert(d.name && d.audio_url && /^https:\/\//.test(d.audio_url), '缺少 audio_url')
    assert(d.lyric && d.lyric.length > 100, '缺少歌词')
    ok(`GET /song/detail -> 《${d.name}》 audio_url=${d.audio_url.slice(0, 45)}… lyric=${d.lyric.length}字符`)
  } catch (e) { bad('song_detail', e.message) }

  // 4) audio_info（spade_a 等可见字段）
  try {
    const r = await api('/audio/info?track_id=7079108541549643812')
    assert(r.status === 200 && r.body.code === 0)
    const d = r.body.data
    assert(d.track_id && d.has_audio_url === true, 'has_audio_url 应为 true')
    ok(`GET /audio/info -> has_audio_url=${d.has_audio_url} spade_a=${d.has_spade_a ? '有' : '无'}`)
  } catch (e) { bad('audio_info', e.message) }

  // 5) download_url（白名单校验后地址）
  try {
    const r = await api('/download/url?track_id=7079108541549643812')
    assert(r.status === 200 && r.body.code === 0)
    const d = r.body.data
    assert(/^https:\/\/([a-z0-9-]+\.)?douyinvod\.com\//i.test(d.audio_url), `域名非 douyinvod: ${(d.audio_url || '').slice(0, 60)}`)
    ok(`GET /download/url -> ${d.audio_url.slice(0, 60)}…`)
  } catch (e) { bad('download_url', e.message) }

  // 6) lyric
  try {
    const r = await api('/lyric?track_id=7079108541549643812')
    assert(r.status === 200 && r.body.code === 0)
    ok('GET /lyric -> ' + (r.body.data.lrc ? `LRC ${r.body.data.lrc.length} 字符` : '空歌词'))
  } catch (e) { bad('lyric', e.message) }

  // 7) 已移除的登录/个人接口应 404（鉴权用例之前执行，避免 API_KEY 干扰）
  try {
    const removed = ['/media/player?track_id=7079108541549643812', '/auth/qrcode', '/auth/me', '/auth/qrcode/status', '/me/playlists', '/me/collection/mixed', '/daily/mix', '/video/detail', '/playlist/feed/media', '/playlist/related/media', '/feed/listen/video']
    let checked = 0
    for (const p of removed) {
      const r = await api(p, undefined, {})
      assert(r.status === 404 && r.body && r.body.code === 40400, `${p} 应 404，实际 ${r.status}`)
      checked += 1
    }
    ok(`已移除的登录/个人接口全部 404（${checked} 个）`)
  } catch (e) { bad('已移除接口 404', e.message) }

  // 8) search_playlist（PC 歌单搜索仍可用）
  try {
    const r = await api('/search/playlist?keywords=' + encodeURIComponent('周杰伦'))
    assert(r.status === 200 && r.body.code === 0)
    assert(r.body.data.playlists.length > 0, '无歌单')
    ok(`GET /search/playlist -> ${r.body.data.playlists.length} 个歌单（${r.body.data.playlists[0].title}）`)
  } catch (e) { bad('search_playlist', e.message) }

  // 9) decrypt_spade 校验（无效 spade_a 应报错）
  try {
    const r = await api('/decrypt/spade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spade_a: '!!!not-base64!!!' }) })
    assert(r.status >= 400 && r.body.code === 40000, `应报错: ${r.status} ${r.body && r.body.code}`)
    ok('POST /decrypt/spade 无效输入 -> 校验错误')
  } catch (e) { bad('decrypt_spade', e.message) }

  // 10) bodyOnly 路由 GET 应被拒绝（原版 Express 对 POST-only 路由 GET 同样 404）
  try {
    const r = await api('/download/file?url=https://x.com/a.m4a')
    assert(r.status === 404 && r.body.code === 40400, `应 404: ${r.status} ${r.body && r.body.code}`)
    ok('POST-only 路由 GET -> 404（与原版行为一致）')
  } catch (e) { bad('bodyOnly GET', e.message) }

  // 11) JSON body 限长
  try {
    const big = JSON.stringify({ body: 'x'.repeat(1024 * 1024 + 100) })
    const r = await api('/decrypt/spade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big })
    assert(r.status === 400, `应 400: ${r.status}`)
    ok('超大请求体 -> 400')
  } catch (e) { bad('body 限制', e.message) }

  // 12) 鉴权（API_KEY 已配置时；这些用例必须放最后，因为会在 process.env 写入 API_KEY）
  const TEST_KEY = process.env.TEST_API_KEY || 'test-secret-123'
  const KEY_ENV = { API_KEY: TEST_KEY }
  try {
    const r = await api('/api/capabilities', undefined, KEY_ENV)
    assert(r.status === 401 && r.body && r.body.code === 40100, `应 401: ${r.status} ${r.body && r.body.code}`)
    ok('鉴权：无密钥 -> 401')
  } catch (e) { bad('鉴权 401', e.message) }

  try {
    const r = await api('/api/capabilities', { headers: { 'X-API-Key': TEST_KEY } }, KEY_ENV)
    assert(r.status === 200 && r.body.code === 0, `应 200: ${r.status}`)
    ok('鉴权：X-API-Key 头 -> 200')
  } catch (e) { bad('鉴权 X-API-Key 头', e.message) }

  try {
    const r = await api('/api/capabilities?key=' + TEST_KEY, undefined, KEY_ENV)
    assert(r.status === 200, `应 200: ${r.status}`)
    ok('鉴权：?key= 查询参数 -> 200')
  } catch (e) { bad('鉴权 ?key=', e.message) }

  try {
    const r = await api('/api/capabilities', { headers: { Authorization: 'Bearer ' + TEST_KEY } }, KEY_ENV)
    assert(r.status === 200, `应 200: ${r.status}`)
    ok('鉴权：Authorization Bearer -> 200')
  } catch (e) { bad('鉴权 Bearer', e.message) }

  try {
    const r = await api('/api/capabilities', { headers: { 'X-API-Key': 'wrong' } }, KEY_ENV)
    assert(r.status === 401, `应 401: ${r.status}`)
    ok('鉴权：错误密钥 -> 401')
  } catch (e) { bad('鉴权错误密钥', e.message) }

  try {
    const r = await api('/health', undefined, KEY_ENV)
    assert(r.status === 200 && r.body.code === 0, `应 200: ${r.status}`)
    ok('鉴权：/health 免鉴权放行')
  } catch (e) { bad('鉴权 health', e.message) }

  console.log(`\n结果: pass=${pass} fail=${fail}`)
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})