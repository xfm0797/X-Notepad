# 插件市场索引

`index.json` 就是插件市场唯一的数据源，客户端按顺序试三个地址：

1. `https://cdn.jsdelivr.net/gh/xfm0797/X-Notepad@main/market/index.json`（快，但有 7 天 CDN 缓存，客户端会带 `_t` 时间戳绕过）
2. `https://raw.githubusercontent.com/xfm0797/X-Notepad/main/market/index.json`
3. `https://gitee.com/xfm0797/X-Notepad/raw/main/market/index.json`

用户在「插件 → 插件市场 → 换源」里还能填自己的索引地址，填了就先试它。

## 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 必须和插件 `plugin.json` 里的 `id` 一致，也用作安装目录名（只允许 `a-z 0-9 - _ .`） |
| `name` | ✅ | 展示名 |
| `version` | ✅ | SemVer，客户端用它和已装版本比大小 |
| `url` | ✅ | 插件包 zip 直链 |
| `description` | | 一句话说明 |
| `author` | | 作者 |
| `extensions` | | 负责的扩展名，仅展示用 |
| `abi` | | 默认 1（核心模块）；组件插件填 2 |
| `permissions` | | 插件要用的宿主能力，如 `["log","read-setting"]`；只用于安装前提示，装了以包里的 `plugin.json` 为准 |
| `homepage` | | 项目主页 |

## 发布一个新插件

```bash
# 1. 编 wasm（示例是 Rust，任何能编到 wasm32 的语言都行）
cd plugins/csv-viewer && ./build.sh

# 2. 打包：只把 plugin.json 和 wasm 放进去，别把 target/ 打进去
#    带 -KeyPath 就顺带签名（签名在压缩前做，摘要算的是进包的那几个文件）
scripts/pack-plugin.ps1 -PluginDir plugins/csv-viewer -KeyPath ~/.xnp-signing/xfm-official.json

# 3. 把 dist-plugins/csv-viewer.zip 传到 Release，保证和 index.json 里的 url 对得上
# 4. 在 index.json 里加/改条目，然后 push
```

## 签名

包里的 `signature.json` 用 ed25519 签「内容摘要」：

```json
{ "algo": "ed25519", "keyId": "xfm-official", "digest": "…64 位…", "signature": "…128 位…" }
```

客户端装之前先验：验不过直接拒绝；没签名、或 `keyId` 不在信任名单里只提示。官方公钥编译在
客户端里（`src-tauri/src/plugin_sig.rs` 的 `OFFICIAL_KEYS`），私钥由维护者离线保管，
**不要提交进仓库**。第三方作者要签名，让用户在「插件 → 签名密钥」里贴公钥即可。

格式与判定规则见 [`../docs/plugin-sign.md`](../docs/plugin-sign.md)。


注意：客户端会校验包里的 `plugin.json`，`id` 与索引不一致会拒绝安装，`entry` 指向的
wasm 不存在也会拒绝——所以别只改索引不改包。

`permissions` 也建议跟包里写一致：客户端装完会拿索引和包里的清单对一遍，包申请得更多时
会在界面上提示用户「实际申请得更多」。作者自己漏写权限时插件跑起来会直接被拒（报错会
说缺哪个），别指望宿主兜底。
