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
| `homepage` | | 项目主页 |

## 发布一个新插件

```bash
# 1. 编 wasm（示例是 Rust，任何能编到 wasm32 的语言都行）
cd plugins/csv-viewer && ./build.sh

# 2. 打包：只把 plugin.json 和 wasm 放进去，别把 target/ 打进去
powershell -File scripts/pack-plugin.ps1 -PluginDir plugins/csv-viewer

# 3. 把 dist-plugins/csv-viewer.zip 传到 Release，保证和 index.json 里的 url 对得上
# 4. 在 index.json 里加/改条目，然后 push
```

注意：客户端会校验包里的 `plugin.json`，`id` 与索引不一致会拒绝安装，`entry` 指向的
wasm 不存在也会拒绝——所以别只改索引不改包。
