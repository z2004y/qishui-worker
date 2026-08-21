// 诊断：/discover 结构 + 上游电台端点探测（免登录）
const { setGlobalDispatcher, ProxyAgent } = require('undici')
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7890'))
const W = 'https://qishui-api.zzy721683736.workers.dev'

;(async () => {
  const u = new URL(W + '/discover')
  u.searchParams.set('key', '721683736')
  const d = await (await fetch(u)).json()
  const data = d.data || d
  console.log('top keys:', Object.keys(data).join(','))
  const blocks = Array.isArray(data.blocks) ? data.blocks : []
  console.log('blocks count:', blocks.length)
  const types = {}
  for (const b of blocks) {
    const t = (b && b.type) || '(no type)'
    types[t] = (types[t] || 0) + 1
  }
  console.log('block types:', JSON.stringify(types))
  // 看第一个块的结构样例
  const b0 = blocks[0] || {}
  console.log('block[0] keys:', Object.keys(b0).join(','))
  if (b0.blocks && Array.isArray(b0.blocks)) console.log('block[0].blocks:', b0.blocks.length)
  // 全树找 radio
  let hits = []
  const walk = (v, p, depth) => {
    if (!v || typeof v !== 'object' || depth > 6) return
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + '[' + i + ']', depth + 1)); return }
    for (const [k, val] of Object.entries(v)) {
      if (/radio/i.test(k)) hits.push(p + '.' + k + '=' + (Array.isArray(val) ? 'array(' + val.length + ')' : typeof val === 'object' ? 'obj' : String(val).slice(0, 40)))
      if (typeof val === 'object') walk(val, p + '.' + k, depth + 1)
    }
  }
  walk(data, '', 0)
  console.log('radio 命中:', hits.length ? '\n  ' + hits.slice(0, 12).join('\n  ') : '无')
  // 上游候选电台端点
  const LUNA = 'https://beta-luna.douyin.com'
  const H = { 'Content-Type': 'application/json', 'User-Agent': 'Luna/19.1.0 Android' }
  for (const path of ['/luna/radio/list', '/luna/feed/radio/list', '/luna/feed/radio-song', '/luna/radio/detail', '/luna/discover/radio']) {
    try {
      const rr = await fetch(LUNA + path, { method: 'POST', headers: H, body: '{}' })
      const t = await rr.text()
      let k = ''
      try { k = Object.keys(JSON.parse(t)).join(',') } catch (_) {}
      console.log('POST', path, '-> http', rr.status, 'keys:', k || 'non-json', 'len:', t.length, 'head:', t.slice(0, 100).replace(/\n/g, ''))
    } catch (e) { console.log('POST', path, 'ERR', e.message) }
  }
})()