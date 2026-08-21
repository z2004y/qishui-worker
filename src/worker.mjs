/**
 * qishui-api —— Cloudflare Workers 移植版（ESM 入口）
 *
 * 对应原仓库 server.js（Express）：
 *  - Express 动态模块扫描 -> 静态路由表 src/routes.js
 *  - express.json(1mb) -> readRequestBody() 手动解析并限长
 *  - 其余逻辑（统一响应 ok/fail、CORS、HttpError 映射）逐条对应
 *
 * 部署要求：
 *  - compatibility_date >= 2026-08-04（nodejs_compat 默认启用，提供 Buffer/process.env）
 *  - 重路由（/download/file、/audio/decrypt 的 50MB base64 下载+解密）建议付费版
 */
import config from './config.js'
import { QishuiClient } from './qishuiClient.js'
import { HttpError, ValidationError } from './errors.js'
import { ok, fail } from './response.js'
import { sanitizeForExternal } from './redaction.js'
import MODULES from './routes.js'

const APP_NAME = 'qishui-api'
const APP_VERSION = '1.0.0'
const JSON_LIMIT = 1024 * 1024 // express.json limit: '1mb'

function createTraceId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function moduleDefs() {
  return Object.entries(MODULES).map(([name, handler]) => ({
    name,
    route: handler.route || `/${name.replace(/_/g, '/')}`,
    handler,
  }))
}

function corsHeaders(request) {
  const allow = String(config.corsAllowOrigin || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const headers = {
    'Access-Control-Allow-Headers': 'X-Requested-With,Content-Type,Cookie',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  }
  if (allow.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*'
  } else {
    const origin = request && request.headers.get('origin')
    if (origin && allow.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Access-Control-Allow-Credentials'] = 'true'
    }
  }
  return headers
}

function json(body, headers, status = 200) {
  return new Response(JSON.stringify(body), { status, headers })
}

async function readRequestBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return {}
  const contentLength = Number(request.headers.get('content-length') || 0)
  if (contentLength > JSON_LIMIT) throw new ValidationError('请求体超过大小限制', { max_bytes: JSON_LIMIT })
  const text = await request.text()
  if (text.length > JSON_LIMIT) throw new ValidationError('请求体超过大小限制', { max_bytes: JSON_LIMIT })
  if (!text.trim()) return {}
  const contentType = String(request.headers.get('content-type') || '')
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text)
    } catch (_) {
      throw new ValidationError('JSON 解析失败')
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const parsed = {}
    for (const [key, value] of new URLSearchParams(text)) parsed[key] = value
    return parsed
  }
  try {
    return JSON.parse(text)
  } catch (_) {
    throw new ValidationError('请求体格式不支持')
  }
}

export default {
  async fetch(request, env) {
    // 保险：把 Worker 环境变量/密钥补齐到 process.env（config.js 从 process.env 读取）
    if (typeof process !== 'undefined' && process.env && env && typeof env === 'object') {
      for (const [key, value] of Object.entries(env)) {
        if (process.env[key] === undefined || process.env[key] === null) process.env[key] = value
      }
    }

    const headers = corsHeaders(request)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    const traceId = request.headers.get('x-trace-id') || createTraceId()
    let url
    try {
      url = new URL(request.url)
    } catch (_) {
      return json(fail(40000, '无效请求', traceId), headers, 400)
    }

    // ===== 鉴权：除 /health 与 OPTIONS 外全部要求 API_KEY =====
    // 传递方式（任一即可）：X-API-Key 头 / ?key= 查询参数 / Authorization: Bearer <key>
    const apiKey = (typeof process !== 'undefined' && process.env && process.env.API_KEY)
      || (env && env.API_KEY)
      || ''
    if (apiKey && url.pathname !== '/health') {
      const provided =
        request.headers.get('x-api-key')
        || url.searchParams.get('key')
        || String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
      if (provided !== apiKey) {
        return json(
          fail(40100, '未授权：请在 X-API-Key 头 / ?key= 参数 / Authorization Bearer 中提供正确密钥', traceId, { path: url.pathname }),
          headers,
          401,
        )
      }
    }

    try {
      const client = new QishuiClient()
      const defs = moduleDefs()

      if (url.pathname === '/') {
        return json(ok({ name: APP_NAME, version: APP_VERSION, routes: defs.map((d) => d.route) }, traceId), headers)
      }
      if (url.pathname === '/health') {
        return json(ok({ status: 'ok' }, traceId), headers)
      }
      if (url.pathname === '/api/list') {
        return json(ok(defs.map((d) => ({ route: d.route, file: `${d.name}.js` })), traceId), headers)
      }

      const def = defs.find((d) => d.route === url.pathname)
      if (!def) {
        return json(fail(40400, '接口不存在', traceId, { path: url.pathname }), headers, 404)
      }

      const declaredMethods = Array.isArray(def.handler.methods) && def.handler.methods.length
        ? def.handler.methods
        : ['get', 'post']
      const method = request.method.toLowerCase()
      if (!declaredMethods.includes(method)) {
        return json(fail(40400, '接口不存在', traceId, { path: url.pathname, method }), headers, 404)
      }

      if (def.handler.bodyOnly && url.searchParams.size) {
        throw new ValidationError('敏感参数必须放在 POST JSON body 中')
      }

      const body = await readRequestBody(request)
      const input = {
        ...Object.fromEntries(url.searchParams),
        ...body,
        body,
      }
      const data = await def.handler(input, {
        req: request,
        client,
        cookie: request.headers.get('cookie') || '',
        traceId,
      })
      // 模块可返回 { status, body } 自定义状态码
      if (data && typeof data === 'object' && data.status && data.body) {
        return json(data.body, headers, data.status)
      }
      return json(ok(data, traceId), headers)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      const code = error instanceof HttpError ? error.code : 50000
      const message = error instanceof HttpError ? error.message : '服务器内部错误'
      const details = error instanceof HttpError && error.details ? sanitizeForExternal(error.details) : undefined
      return json(fail(code, message, traceId, details), headers, status)
    }
  },
}