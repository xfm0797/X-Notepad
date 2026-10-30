# 插件包签名

插件能跑在沙箱里，但**沙箱防的是插件作恶，防不了「有人把插件换了」**。
签名解决后一件事：装上的是作者当时打的那个包，中途没被人动过。

实现：`src-tauri/src/plugin_sig.rs`（验签）、`scripts/sign-plugin.mjs`（生成密钥 / 签名 / 验签）。

## 包里多一个 `signature.json`

和 `plugin.json` 平级：

```json
{
  "algo": "ed25519",
  "keyId": "xfm-official",
  "digest": "8f14e45fceea167a5a36dedd4bea2543…",
  "signature": "3b1f…（128 个十六进制字符）"
}
```

- `algo` 目前只有 `ed25519`
- `keyId` 是「谁签的」，客户端拿它去信任名单里找公钥
- `digest` 是**内容摘要**，见下
- `signature` 是对摘要那 32 个原始字节的签名

## 内容摘要怎么算

除 `signature.json` 外，包里每个文件算一行：

```
{sha256(文件内容)}  {相对路径}
```

两个空格分隔，路径用 `/`、相对 `plugin.json` 所在目录，行尾换行。所有行**按路径排序**后
拼起来，再 sha256 一次，得到 32 字节摘要。

这样定义的好处：

- **重新打包不影响**：换压缩级别、换 zip 工具、改文件时间戳，摘要都不变
- **改内容立刻暴露**：动一个字节、改名、加一个文件，摘要全变
- **两端容易对齐**：Rust 与 Node 各写十几行，不需要共享库

`signature.json` 自己不参与计算（否则自我指涉），但它被排除这件事是**写死在两端的**，
攻击者塞一个新的 `signature.json` 只会让签名对不上。

## 客户端怎么判

| 情况 | 状态 | 能不能装 |
| --- | --- | --- |
| 没有 `signature.json` | `unsigned` 未签名 | 能，界面标出来 |
| 有签名，`keyId` 不在信任名单 | `untrusted` 密钥未信任 | 能，提示去「签名密钥」里加公钥 |
| 有签名，密钥认识，摘要与签名都对 | `verified` 签名有效 | 能 |
| 有签名，密钥认识，但内容或签名对不上 | `invalid` 签名无效 | **不能**，解包前就拒 |

密钥不认识时没法验签（公钥就来自信任名单），所以只能退化成提醒；一旦用户把公钥加进
信任名单，同一个包再验就是 `verified` 或 `invalid`——不会停在模糊状态。

验签发生在**解包之前**：内容被改过的包一个字节都不会落进插件目录。装完之后插件面板还会
对目录再算一次摘要，装完被人手动改文件同样会显示「签名无效」。

## 信任名单

- 官方公钥编译在客户端里（`plugin_sig::OFFICIAL_KEYS`），界面标「内置」，删不掉
- 用户自己加的在 `<数据目录>/plugin-keys.json`，插件面板 →「签名密钥」里管理
- 同 `keyId` 以用户的为准，方便作者轮换密钥；内置那条的「内置」属性不变

私钥由作者自己保管，**永远不进仓库**。生成密钥时 `sign-plugin.mjs` 会把权限设成 600
（Windows 上尽力而为），并打印公钥。

## 签名一个插件

```bash
# 1. 一次性：生成密钥（私钥放仓库外面）
node scripts/sign-plugin.mjs keygen --id xfm-official --label "XFM 官方" \
  --out ~/.xnp-signing/xfm-official.json

# 2. 编 wasm
cd plugins/csv-viewer && ./build.sh

# 3. 打包 + 签名（签名在压缩之前，摘要算的就是进包的那几个文件）
powershell -File scripts/pack-plugin.ps1 -PluginDir plugins/csv-viewer \
  -KeyPath ~/.xnp-signing/xfm-official.json

# 4. 随便验一下
node scripts/sign-plugin.mjs verify <解包目录> --key ~/.xnp-signing/xfm-official.json
```

`pack-plugin.ps1` 不带 `-KeyPath` 也能打，只是包没有签名，客户端会标「未签名」。

## 为什么不直接签 zip 文件

zip 字节里带着时间戳和压缩细节：同一批文件重打一次，字节就变了，签名立刻失效。
签「内容摘要」而不是「zip 字节」，包可以重打、可以换镜像源、可以进 CDN，验签结果都一样。
代价是必须把每个文件都读一遍算 sha256——插件包上限 32MB，这个代价可以接受。

## 边界

- 签名只证明「谁打的包、有没有被改」，不证明「插件是安全的」：作者自己的包拿到
  `log` 权限照样能刷日志。能力清单和沙箱才是干这个的
- 不做证书链、没有吊销列表。换密钥就是在信任名单里加新 `keyId`，老的留着让旧包还能验
- `unsigned` 默认放行：自建插件、自己编的包本来就没人签，拦下来只会挡住正常使用
