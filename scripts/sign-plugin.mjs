#!/usr/bin/env node
/**
 * 插件包签名 / 验签 / 生成密钥（Node 自带 ed25519，不用装任何依赖）。
 *
 * 摘要算法和 Rust 侧 `src-tauri/src/plugin_sig.rs` 必须完全一致：
 *   - 除 signature.json 外，每个文件一行 `{sha256(内容)}  {相对路径}\n`
 *   - 路径用 `/`，相对本目录，按字节序排序
 *   - 再 sha256 一次得到 32 字节摘要，对它签名（不是对十六进制字符串签）
 *
 * 用法：
 *   node scripts/sign-plugin.mjs keygen --id xfm-official --label "XFM 官方" --out ../keys/xfm.json
 *   node scripts/sign-plugin.mjs sign   <目录> --key <私钥 json> [--out <目录>]
 *   node scripts/sign-plugin.mjs verify <目录> [--keyring market/keyring.json]
 *
 * 私钥文件长这样，**别提交进仓库**：
 *   { "id": "xfm-official", "label": "XFM 官方",
 *     "publicKey": "<64 hex>", "privateKey": "<pkcs8 base64>" }
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const SIG_FILE = 'signature.json'

function usage(msg) {
  if (msg) console.error(`错误：${msg}\n`)
  console.error(
    [
      '用法：',
      '  keygen --id <id> [--label <名字>] --out <私钥.json>',
      '  sign   <目录> --key <私钥.json> [--out <输出目录>]',
      '  verify <目录> [--key <私钥.json> | --keyring <keyring.json>]'
    ].join('\n')
  )
  process.exit(msg ? 1 : 0)
}

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

/* ------------------------------ 摘要 ------------------------------ */

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest()
}

/** 递归列文件，跳过 signature.json 与隐藏目录，路径统一 / */
function listFiles(dir, base = dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue
      listFiles(full, base, out)
    } else if (e.isFile()) {
      const rel = path.relative(base, full).split(path.sep).join('/')
      if (rel === SIG_FILE) continue
      out.push({ rel, data: fs.readFileSync(full) })
    }
  }
  return out
}

export function contentDigest(files) {
  const rows = files
    .map(f => ({
      rel: f.rel.replace(/\\/g, '/'),
      hash: sha256(f.data).toString('hex')
    }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.rel, 'utf8'), Buffer.from(b.rel, 'utf8')))

  const h = crypto.createHash('sha256')
  for (const r of rows) {
    h.update(r.hash)
    h.update('  ')
    h.update(r.rel, 'utf8')
    h.update('\n')
  }
  return h.digest('hex')
}

/* ------------------------------ 密钥 ------------------------------ */

function loadPrivateKey(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!raw.privateKey) throw new Error(`${file} 里没有 privateKey`)
  const key = crypto.createPrivateKey({
    key: Buffer.from(raw.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
  return { id: raw.id, label: raw.label ?? raw.id, key }
}

/** SPKI DER 末尾 32 字节就是公钥本体 */
function rawPublicKey(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return der.subarray(der.length - 32)
}

/* ------------------------------ 子命令 ------------------------------ */

function keygen(args) {
  const id = args.id
  const out = args.out
  if (!id || !out) usage('keygen 需要 --id 和 --out')
  if (fs.existsSync(out)) usage(`${out} 已存在，换个位置或先删掉`)

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const json = {
    id,
    label: args.label ?? id,
    publicKey: rawPublicKey(publicKey).toString('hex'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(json, null, 2))
  try {
    fs.chmodSync(out, 0o600)
  } catch {
    /* Windows 上没有这一套，忽略 */
  }
  console.log(`已生成密钥 ${id}`)
  console.log(`  公钥（贴进 keyring）：${json.publicKey}`)
  console.log(`  私钥文件（别提交）：${out}`)
}

function sign(args) {
  const dir = args._[0]
  const keyFile = args.key
  if (!dir || !keyFile) usage('sign 需要 <目录> 和 --key')
  if (!fs.existsSync(dir)) usage(`目录不存在：${dir}`)

  const { key } = loadPrivateKey(keyFile)
  const files = listFiles(dir)
  if (!files.length) usage('目录里没有可签名的文件')

  const digest = contentDigest(files)
  const signature = crypto.sign(null, Buffer.from(digest, 'hex'), key).toString('hex')

  const block = {
    algo: 'ed25519',
    keyId: JSON.parse(fs.readFileSync(keyFile, 'utf8')).id,
    digest,
    signature
  }
  const text = JSON.stringify(block, null, 2) + '\n'
  const target = args.out ? path.join(args.out, SIG_FILE) : path.join(dir, SIG_FILE)
  fs.writeFileSync(target, text)
  console.log(`已签名 ${files.length} 个文件 → ${target}`)
  console.log(`  keyId: ${block.keyId}`)
  console.log(`  digest: ${digest}`)
}

function verify(args) {
  const dir = args._[0]
  if (!dir) usage('verify 需要 <目录>')

  const files = listFiles(dir)
  const digest = contentDigest(files)
  const sigPath = path.join(dir, SIG_FILE)
  if (!fs.existsSync(sigPath)) {
    console.log(`未签名（digest ${digest}）`)
    return
  }
  const block = JSON.parse(fs.readFileSync(sigPath, 'utf8'))
  let publicKeyHex = ''
  if (args.key) {
    // 手上只有私钥时也能验：直接把公钥推出来
    const { key } = loadPrivateKey(args.key)
    publicKeyHex = rawPublicKey(crypto.createPublicKey(key)).toString('hex')
  } else if (args.keyring) {
    const ring = JSON.parse(fs.readFileSync(args.keyring, 'utf8'))
    const keys = Array.isArray(ring) ? ring : ring.keys ?? []
    const hit = keys.find(k => k.id === block.keyId)
    publicKeyHex = hit?.publicKey ?? ''
    if (!hit) console.log(`密钥 ${block.keyId} 不在 ${args.keyring} 里`)
  }

  if (block.digest !== digest) {
    console.error('摘要对不上：包被改过')
    process.exit(1)
  }
  if (!publicKeyHex) {
    console.log(`摘要一致（${digest}），但没给公钥，没法验签名`)
    return
  }
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyHex, 'hex')]),
    format: 'der',
    type: 'spki'
  })
  const ok = crypto.verify(null, Buffer.from(digest, 'hex'), key, Buffer.from(block.signature, 'hex'))
  console.log(ok ? `签名有效（${block.keyId}，${digest}）` : '签名无效')
  if (!ok) process.exit(1)
}

/* ------------------------------ 入口 ------------------------------ */

const args = parseArgs(process.argv.slice(2))
const cmd = args._.shift()
if (cmd === 'keygen') keygen(args)
else if (cmd === 'sign') sign(args)
else if (cmd === 'verify') verify(args)
else usage(cmd ? `不认识的子命令：${cmd}` : '')
