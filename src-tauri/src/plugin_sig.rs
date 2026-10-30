//! 插件包签名校验：Ed25519 签「内容摘要」。
//!
//! ## 包里的签名文件
//!
//! `signature.json`，和 `plugin.json` 平级：
//!
//! ```json
//! { "algo": "ed25519", "keyId": "xfm-official",
//!   "digest": "<64 位十六进制>", "signature": "<128 位十六进制>" }
//! ```
//!
//! ## 内容摘要怎么算
//!
//! 除 `signature.json` 以外，包里每个文件算一行
//! `{sha256(文件内容)}  {相对路径}\n`（两个空格，路径用 `/`，相对清单所在目录），
//! 按路径排序后连起来再 sha256 一次。所以**重新打包**（换时间戳、换压缩级别、
//! 甚至换 zip 工具）不会改变摘要，只有文件内容或文件名变了才会。
//!
//! 签名的是摘要那 32 个原始字节，不是十六进制字符串——省得纠结大小写。
//!
//! ## 判定
//!
//! | 情况 | 结果 | 安装 |
//! | --- | --- | --- |
//! | 没有 `signature.json` | `unsigned` | 允许，界面标「未签名」 |
//! | 签了，但 `keyId` 不在信任名单 | `untrusted` | 允许，界面标「密钥未信任」 |
//! | 签了，密钥认识，摘要与签名都对 | `verified` | 允许，标「签名有效」 |
//! | 签了，密钥认识，但内容对不上 / 签名不成立 | `invalid` | **拒绝** |
//!
//! 密钥不认识时没法验签（公钥就来自信任名单），所以只能退化成提醒——但用户
//! 想信任某个 keyId 之后，同一个包再验一次就会变成 `verified` 或 `invalid`。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

/// 签名文件名（相对清单目录）
pub const SIG_FILE: &str = "signature.json";
/// 签名算法只有这一种，写进包里是为了将来看得懂
pub const ALGO: &str = "ed25519";

/// 内置的官方公钥。私钥由维护者离线保管，不随仓库走。
/// 换密钥就往后加一条，旧的留着，已经发出去的包还能验。
pub const OFFICIAL_KEYS: &[(&str, &str, &str)] = &[(
    "xfm-official",
    "fc7d170f6f1b3c61bc24deb8c6e19b88e110cc7c82bff637d0fd6da0e454d850",
    "XFM 官方",
)];

/// 信任的公钥
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustedKey {
    pub id: String,
    /// 32 字节公钥的十六进制（64 个字符）
    pub public_key: String,
    #[serde(default)]
    pub label: String,
    /// 编译在客户端里的官方密钥：界面上不给删（删了下次启动又回来）
    #[serde(default)]
    pub builtin: bool,
}

/// 签名文件的内容
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignatureBlock {
    #[serde(default = "algo_default")]
    algo: String,
    key_id: String,
    digest: String,
    signature: String,
}

fn algo_default() -> String {
    ALGO.to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SigStatus {
    Unsigned,
    Verified,
    Untrusted,
    Invalid,
}

impl SigStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SigStatus::Unsigned => "unsigned",
            SigStatus::Verified => "verified",
            SigStatus::Untrusted => "untrusted",
            SigStatus::Invalid => "invalid",
        }
    }

    /// 内容对不上、签名不成立时才算坏包，其它情况都只是提醒
    pub fn is_fatal(self) -> bool {
        matches!(self, SigStatus::Invalid)
    }
}

/// 露给前端 / 塞进 [`crate::plugins::PluginInfo`] 的验签结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureInfo {
    pub status: SigStatus,
    /// 包里声明的密钥 id（没签名就是 None）
    pub key_id: Option<String>,
    /// 信任名单里这个密钥的备注名
    pub key_label: Option<String>,
    /// 算出来的内容摘要，出问题时对着一看就知道包有没有被换过
    pub digest: String,
    /// 一句话说明，直接能显示给用户
    pub detail: String,
}

impl SignatureInfo {
    fn new(status: SigStatus, digest: String, detail: String) -> Self {
        Self {
            status,
            key_id: None,
            key_label: None,
            digest,
            detail,
        }
    }
}

fn hex_of(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((b & 0x0f) as u32, 16).unwrap_or('0'));
    }
    out
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 || s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

/// 单个文件的 sha256 十六进制
pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex_of(&h.finalize())
}

/// 内容摘要：排序后的 `{文件 sha256}  {路径}` 再哈希一次。
/// `signature.json` 自己当然不算在内。
pub fn content_digest(files: &[(String, Vec<u8>)]) -> String {
    let mut rows: Vec<(String, String)> = files
        .iter()
        .filter(|(name, _)| name != SIG_FILE)
        // 路径统一成 `/`，Windows 上解出来的包也能对上
        .map(|(name, data)| (name.replace('\\', "/"), sha256_hex(data)))
        .collect();
    rows.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));

    let mut h = Sha256::new();
    for (name, hash) in rows {
        h.update(hash.as_bytes());
        h.update(b"  ");
        h.update(name.as_bytes());
        h.update(b"\n");
    }
    hex_of(&h.finalize())
}

/// 校验一次：`block` 是 `signature.json` 的原文（没有就传 None），
/// `keys` 是信任名单（调用方负责把内置官方密钥拼进去）。
pub fn verify_files(
    files: &[(String, Vec<u8>)],
    block: Option<&str>,
    keys: &[TrustedKey],
) -> SignatureInfo {
    let digest = content_digest(files);

    let Some(raw) = block else {
        return SignatureInfo::new(
            SigStatus::Unsigned,
            digest,
            "这个包没有签名，无法确认是谁打的包、中途有没有被改过。".into(),
        );
    };

    let sig: SignatureBlock = match serde_json::from_str(raw) {
        Ok(s) => s,
        Err(e) => {
            let mut info =
                SignatureInfo::new(SigStatus::Invalid, digest, format!("签名文件格式不对：{e}"));
            info.key_id = None;
            return info;
        }
    };

    if !sig.algo.eq_ignore_ascii_case(ALGO) {
        let mut info = SignatureInfo::new(
            SigStatus::Invalid,
            digest,
            format!("不认识的签名算法：{}", sig.algo),
        );
        info.key_id = Some(sig.key_id);
        return info;
    }

    let key = keys
        .iter()
        .find(|k| k.id.eq_ignore_ascii_case(sig.key_id.trim()));

    let Some(key) = key else {
        let mut info = SignatureInfo::new(
            SigStatus::Untrusted,
            digest,
            format!(
                "包上写着由「{}」签名，但这个密钥不在信任名单里，没法验证。",
                sig.key_id
            ),
        );
        info.key_id = Some(sig.key_id);
        return info;
    };

    let mut info = SignatureInfo::new(SigStatus::Verified, digest.clone(), String::new());
    info.key_id = Some(key.id.clone());
    info.key_label = Some(if key.label.is_empty() {
        key.id.clone()
    } else {
        key.label.clone()
    });

    // 1) 包里声明的摘要要和实测一致
    if !sig.digest.eq_ignore_ascii_case(&digest) {
        info.status = SigStatus::Invalid;
        info.detail = "包的内容和签名时记录的摘要对不上，装之前请重新下载。".into();
        return info;
    }

    // 2) 签名要真的成立
    match (unhex(&key.public_key), unhex(&sig.signature)) {
        (Some(pk), Some(s)) if pk.len() == 32 && s.len() == 64 => {
            use ed25519_dalek::{Signature, Verifier, VerifyingKey};
            let vk = match VerifyingKey::from_bytes(&pk[..32].try_into().unwrap()) {
                Ok(v) => v,
                Err(e) => {
                    info.status = SigStatus::Invalid;
                    info.detail = format!("信任名单里这把公钥不可用：{e}");
                    return info;
                }
            };
            let raw_digest = unhex(&digest).unwrap_or_default();
            let sig = Signature::from_bytes(&s[..64].try_into().unwrap());
            if vk.verify(&raw_digest, &sig).is_err() {
                info.status = SigStatus::Invalid;
                info.detail = "签名验证失败，这个包不是你信任的那把私钥签的。".into();
                return info;
            }
            info.detail = format!("内容摘要与签名都验证通过（{}）。", info.key_label.clone().unwrap_or_default());
        }
        _ => {
            info.status = SigStatus::Invalid;
            info.detail = "信任名单里的公钥或签名不是合法的十六进制串。".into();
        }
    }
    info
}

/// 把签名文件原文从文件列表里挑出来
pub fn block_of<'a>(files: &'a [(String, Vec<u8>)]) -> Option<String> {
    files
        .iter()
        .find(|(name, _)| name == SIG_FILE)
        .map(|(_, data)| String::from_utf8_lossy(data).to_string())
}

/// 内置官方密钥 + 用户自己加的
pub fn trusted_keys(extra: Vec<TrustedKey>) -> Vec<TrustedKey> {
    let mut out: Vec<TrustedKey> = OFFICIAL_KEYS
        .iter()
        .map(|(id, pk, label)| TrustedKey {
            id: (*id).to_string(),
            public_key: (*pk).to_string(),
            label: (*label).to_string(),
            builtin: true,
        })
        .collect();
    for k in extra {
        // 同 id 以用户改的为准，方便换密钥；但「内置」这个属性跟着槽位走
        match out.iter_mut().find(|o| o.id == k.id) {
            Some(slot) => {
                let builtin = slot.builtin;
                *slot = k;
                slot.builtin = builtin;
            }
            None => out.push(k),
        }
    }
    out
}

/// 从 `plugin-keys.json` 读用户新增的密钥，文件不存在就是空
pub fn load_keys(path: &Path) -> Vec<TrustedKey> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    #[derive(Deserialize)]
    struct File {
        #[serde(default)]
        keys: Vec<TrustedKey>,
    }
    serde_json::from_str::<File>(&raw)
        .map(|f| f.keys)
        .unwrap_or_default()
}

pub fn save_keys(path: &Path, keys: &[TrustedKey]) -> Result<(), String> {
    #[derive(Serialize)]
    struct File<'a> {
        keys: &'a [TrustedKey],
    }
    let text = serde_json::to_string_pretty(&File { keys })
        .map_err(|e| format!("序列化信任名单失败：{e}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(path, text).map_err(|e| format!("写入信任名单失败：{e}"))
}

/// 已装目录的验签：把目录里的文件读出来照同样的规则算摘要
pub fn verify_dir(dir: &Path, keys: &[TrustedKey]) -> SignatureInfo {
    let mut files = Vec::new();
    collect(dir, dir, &mut files, 0);
    verify_files(&files, block_of(&files).as_deref(), keys)
}

/// 递归收集，路径相对 `root`；深度卡一下，别被奇怪的结构拖死
fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>, depth: usize) {
    if depth > 4 || out.len() > 256 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for entry in items {
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, out, depth + 1);
        } else if let Ok(rel) = path.strip_prefix(root) {
            let name = rel.to_string_lossy().replace('\\', "/");
            // target/ 之类的东西不该参与，插件目录里本来也不会有，但防一手
            if name.starts_with(".unpack-") || name.contains("/target/") {
                continue;
            }
            if let Ok(data) = std::fs::read(&path) {
                out.push((name, data));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// 固定的测试私钥：只用来跑单测，跟官方那把没关系
    fn signer() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn key() -> TrustedKey {
        TrustedKey {
            id: "test-key".into(),
            public_key: hex_of(signer().verifying_key().as_bytes()),
            label: "测试密钥".into(),
            builtin: false,
        }
    }

    fn files() -> Vec<(String, Vec<u8>)> {
        vec![
            (
                "plugin.json".into(),
                r#"{"id":"demo","name":"示例","version":"0.1.0"}"#.as_bytes().to_vec(),
            ),
            ("plugin.wasm".into(), vec![0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]),
        ]
    }

    /// 按包格式签一遍，返回 signature.json 的原文
    fn sign(list: &[(String, Vec<u8>)]) -> String {
        let digest = content_digest(list);
        let raw = unhex(&digest).unwrap();
        let sig = signer().sign(&raw);
        format!(
            r#"{{"algo":"ed25519","keyId":"test-key","digest":"{digest}","signature":"{}"}}"#,
            hex_of(&sig.to_bytes())
        )
    }

    #[test]
    fn digest_ignores_order_and_signature_file() {
        let list = files();
        let mut shuffled = vec![list[1].clone(), list[0].clone()];
        shuffled.push((SIG_FILE.into(), b"whatever".to_vec()));
        assert_eq!(content_digest(&list), content_digest(&shuffled));
    }

    #[test]
    fn digest_changes_with_content() {
        let list = files();
        let mut other = list.clone();
        other[1].1[3] = 0x02;
        assert_ne!(content_digest(&list), content_digest(&other));
    }

    #[test]
    fn digest_changes_with_name() {
        let list = files();
        let mut other = list.clone();
        other[1].0 = "plugin2.wasm".into();
        assert_ne!(content_digest(&list), content_digest(&other));
    }

    #[test]
    fn unsigned_package_is_flagged_not_rejected() {
        let info = verify_files(&files(), None, &[key()]);
        assert_eq!(info.status, SigStatus::Unsigned);
        assert!(!info.status.is_fatal());
        assert!(info.digest.len() == 64);
    }

    #[test]
    fn signed_package_verifies() {
        let list = files();
        let block = sign(&list);
        let info = verify_files(&list, Some(&block), &[key()]);
        assert_eq!(info.status, SigStatus::Verified, "{}", info.detail);
        assert_eq!(info.key_id.as_deref(), Some("test-key"));
        assert_eq!(info.key_label.as_deref(), Some("测试密钥"));
    }

    #[test]
    fn unknown_key_is_untrusted() {
        let list = files();
        let block = sign(&list);
        let info = verify_files(&list, Some(&block), &[]);
        assert_eq!(info.status, SigStatus::Untrusted);
        assert!(!info.status.is_fatal());
        assert_eq!(info.key_id.as_deref(), Some("test-key"));
    }

    #[test]
    fn tampered_content_is_rejected() {
        let list = files();
        let block = sign(&list);
        let mut tampered = list.clone();
        tampered[1].1[4] = 0xff;
        let info = verify_files(&tampered, Some(&block), &[key()]);
        assert_eq!(info.status, SigStatus::Invalid);
        assert!(info.status.is_fatal());
        assert!(info.detail.contains("摘要"), "{}", info.detail);
    }

    #[test]
    fn forged_signature_is_rejected() {
        let list = files();
        let block = sign(&list);
        // 摘要照抄，签名换一把私钥重签
        let parsed: serde_json::Value = serde_json::from_str(&block).unwrap();
        let digest = parsed["digest"].as_str().unwrap().to_string();
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let sig = other.sign(&unhex(&digest).unwrap());
        let forged = format!(
            r#"{{"algo":"ed25519","keyId":"test-key","digest":"{digest}","signature":"{}"}}"#,
            hex_of(&sig.to_bytes())
        );
        let info = verify_files(&list, Some(&forged), &[key()]);
        assert_eq!(info.status, SigStatus::Invalid);
        assert!(info.detail.contains("签名"), "{}", info.detail);
    }

    #[test]
    fn broken_signature_file_is_rejected() {
        let info = verify_files(&files(), Some("{oops"), &[key()]);
        assert_eq!(info.status, SigStatus::Invalid);
        assert!(info.detail.contains("格式"));
    }

    #[test]
    fn unknown_algo_is_rejected() {
        let block = r#"{"algo":"rsa","keyId":"test-key","digest":"00","signature":"00"}"#;
        let info = verify_files(&files(), Some(block), &[key()]);
        assert_eq!(info.status, SigStatus::Invalid);
        assert!(info.detail.contains("算法"));
    }

    #[test]
    fn key_lookup_ignores_case_and_padding() {
        let list = files();
        let block = sign(&list).replace("\"test-key\"", "\" TEST-KEY \"");
        let info = verify_files(&list, Some(&block), &[key()]);
        assert_eq!(info.status, SigStatus::Verified, "{}", info.detail);
    }

    #[test]
    fn hex_roundtrip() {
        let bytes = vec![0x00, 0x0f, 0xa5, 0xff];
        assert_eq!(hex_of(&bytes), "000fa5ff");
        assert_eq!(unhex("000FA5FF").unwrap(), bytes);
        assert!(unhex("abc").is_none());
        assert!(unhex("zz").is_none());
    }

    #[test]
    fn official_and_user_keys_merge() {
        let user = TrustedKey {
            id: "mine".into(),
            public_key: "11".repeat(32),
            label: "我的".into(),
            builtin: false,
        };
        let all = trusted_keys(vec![user.clone()]);
        assert_eq!(all.len(), OFFICIAL_KEYS.len() + 1);
        assert!(all.iter().any(|k| k.id == "mine"));

        // 同 id 时用户那条生效（换密钥场景）
        let replaced = TrustedKey {
            id: OFFICIAL_KEYS[0].0.to_string(),
            public_key: "22".repeat(32),
            label: "换过了".into(),
            builtin: false,
        };
        let all = trusted_keys(vec![replaced]);
        assert_eq!(all.len(), OFFICIAL_KEYS.len());
        assert_eq!(
            all.iter().find(|k| k.id == OFFICIAL_KEYS[0].0).unwrap().label,
            "换过了"
        );
    }

    /// 夹具是 `scripts/sign-plugin.mjs` 用官方私钥签出来的。
    /// 这条测试等于把 Node 签名器与 Rust 验签器钉在一起：
    /// 摘要规则（排序、两个空格、路径分隔符）或签名载荷一变，它就红。
    #[test]
    fn agrees_with_the_node_signer() {
        let files = vec![
            (
                "plugin.json".to_string(),
                include_bytes!("../fixtures/signed-demo/plugin.json").to_vec(),
            ),
            (
                "plugin.wasm".to_string(),
                include_bytes!("../fixtures/signed-demo/plugin.wasm").to_vec(),
            ),
        ];
        let block = include_str!("../fixtures/signed-demo/signature.json");
        let info = verify_files(&files, Some(block), &trusted_keys(Vec::new()));

        assert_eq!(info.status, SigStatus::Verified, "{}", info.detail);
        assert_eq!(info.key_id.as_deref(), Some(OFFICIAL_KEYS[0].0));
        assert_eq!(info.digest, content_digest(&files));
        // 夹具里的摘要确实等于实测摘要，说明两边算的是同一件事
        assert_eq!(
            info.digest,
            "9a5d9d9992ff0d8aed75df930211caf6de911c29c08d3065c1b1f9a910dd4c92"
        );
    }

    #[test]
    fn fixture_tampering_is_caught_by_rust_too() {
        let mut files = vec![
            (
                "plugin.json".to_string(),
                include_bytes!("../fixtures/signed-demo/plugin.json").to_vec(),
            ),
            (
                "plugin.wasm".to_string(),
                include_bytes!("../fixtures/signed-demo/plugin.wasm").to_vec(),
            ),
        ];
        files[1].1[3] = 0x00;
        let block = include_str!("../fixtures/signed-demo/signature.json");
        let info = verify_files(&files, Some(block), &trusted_keys(Vec::new()));
        assert_eq!(info.status, SigStatus::Invalid);
    }

    /// 装完之后对目录再算一次摘要：文件躺在地上，读法不能和包里的那份有出入
    #[test]
    fn verify_dir_reads_the_installed_files() {
        let dir = std::env::temp_dir().join(format!("xnp-sig-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(
            dir.join("plugin.json"),
            include_bytes!("../fixtures/signed-demo/plugin.json"),
        )
        .unwrap();
        std::fs::write(
            dir.join("plugin.wasm"),
            include_bytes!("../fixtures/signed-demo/plugin.wasm"),
        )
        .unwrap();
        std::fs::write(
            dir.join(SIG_FILE),
            include_str!("../fixtures/signed-demo/signature.json"),
        )
        .unwrap();

        let keys = trusted_keys(Vec::new());
        let info = verify_dir(&dir, &keys);
        assert_eq!(info.status, SigStatus::Verified, "{}", info.detail);

        // 装完再塞一个文件进来：摘要变了，签名自然对不上
        std::fs::write(dir.join("assets").join("extra.txt"), b"hi").unwrap();
        let info = verify_dir(&dir, &keys);
        assert_eq!(info.status, SigStatus::Invalid);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
