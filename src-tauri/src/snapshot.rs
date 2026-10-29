//! 全库替换的快照：动手之前先留底，替换完还能一键撤回。
//!
//! 一个快照就是 `<数据目录>/replace-snapshots/<id>/` 一个目录：
//!
//! ```text
//! 0000000000123-0/
//!   manifest.json   这次替换的模式、时间、碰过哪些文件
//!   0.before        第一个文件替换前的原始字节
//!   0.after         第一个文件替换后写下的原始字节
//!   1.before
//!   1.after
//! ```
//!
//! 存原始字节而不是解码后的文本：撤销时能一字不差写回去，编码、BOM、换行符
//! 都不需要再走一遍「解码 → 编码」，GBK 文件也不会越撤越歪。
//!
//! `after` 不是给用户看的，是撤销时的保险：盘上的内容和它一样，才敢覆盖；
//! 不一样说明替换之后又改过，跳过（判断逻辑在 [`crate::replace_plan`]，纯的、可测）。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::replace_plan;

/// 留多少个快照。一次替换一动可能是几十个文件，但也没必要存一年的量
pub const KEEP: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    /// 文件属于哪个工作区（撤销后要按这个 root 重灌索引）
    pub root: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    /// 秒级时间戳
    pub at: u64,
    pub pattern: String,
    pub replacement: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub entries: Vec<Entry>,
}

fn millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

fn secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// 快照 id：定宽的毫秒时间戳 + 序号。定宽是为了按字符串排序就等于按时间排序，
/// 万一同一毫秒里连开两次（脚本化调用）也不会撞目录。
fn new_id(root: &Path) -> String {
    let base = format!("{:013}", millis());
    for n in 0..100 {
        let id = if n == 0 {
            base.clone()
        } else {
            format!("{base}-{n}")
        };
        if !root.join(&id).exists() {
            return id;
        }
    }
    format!("{base}-x{}", millis())
}

fn id_of(name: &str) -> u128 {
    name.split('-')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// 边替换边写的快照。新建失败（磁盘满 / 没权限）时返回 None：
/// 替换照做，只是这一轮没有底可兜，前端会看不到「撤销」。
pub struct Writer {
    dir: PathBuf,
    manifest: Manifest,
    finished: bool,
}

impl Writer {
    pub fn new(
        root: &Path,
        pattern: &str,
        replacement: &str,
        regex: bool,
        case_sensitive: bool,
    ) -> Option<Self> {
        std::fs::create_dir_all(root).ok()?;
        let id = new_id(root);
        let dir = root.join(&id);
        std::fs::create_dir_all(&dir).ok()?;
        Some(Self {
            dir,
            manifest: Manifest {
                id,
                at: secs(),
                pattern: pattern.to_string(),
                replacement: replacement.to_string(),
                regex,
                case_sensitive,
                entries: Vec::new(),
            },
            finished: false,
        })
    }

    /// 在**写盘之前**调用：先把原始字节落进快照，再动真文件。
    /// 写快照失败就返回 false，调用方可以决定「没兜底还要不要改」。
    pub fn push(
        &mut self,
        path: &str,
        root: &str,
        name: &str,
        before: &[u8],
        after: &[u8],
    ) -> bool {
        let i = self.manifest.entries.len();
        let ok = std::fs::write(self.dir.join(format!("{i}.before")), before).is_ok()
            && std::fs::write(self.dir.join(format!("{i}.after")), after).is_ok();
        if !ok {
            let _ = std::fs::remove_file(self.dir.join(format!("{i}.before")));
            let _ = std::fs::remove_file(self.dir.join(format!("{i}.after")));
            return false;
        }
        self.manifest.entries.push(Entry {
            path: path.to_string(),
            root: root.to_string(),
            name: name.to_string(),
        });
        true
    }

    /// 写盘失败：把刚压进去的那条撤回，省得快照里留一个「其实没改成」的文件
    pub fn drop_last(&mut self) {
        if let Some(i) = self.manifest.entries.len().checked_sub(1) {
            self.manifest.entries.pop();
            let _ = std::fs::remove_file(self.dir.join(format!("{i}.before")));
            let _ = std::fs::remove_file(self.dir.join(format!("{i}.after")));
        }
    }

    /// 收尾：写 manifest、清掉过老的快照。一个文件都没碰到就整个丢掉。
    pub fn finish(mut self, keep: usize) -> Option<String> {
        self.finished = true;
        if self.manifest.entries.is_empty() {
            let _ = std::fs::remove_dir_all(&self.dir);
            return None;
        }
        let Ok(json) = serde_json::to_vec_pretty(&self.manifest) else {
            let _ = std::fs::remove_dir_all(&self.dir);
            return None;
        };
        if std::fs::write(self.dir.join("manifest.json"), json).is_err() {
            let _ = std::fs::remove_dir_all(&self.dir);
            return None;
        }
        prune(self.dir.parent().unwrap_or(Path::new(".")), keep.max(1));
        Some(self.manifest.id.clone())
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        // 中途出错直接扔掉，别留一堆没有 manifest 的半个快照
        if !self.finished {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

/// 只保留最近 `keep` 个：替换这种操作真需要翻旧账的场合很少
pub fn prune(root: &Path, keep: usize) {
    let mut ids = ids(root);
    ids.sort_by_key(|id| std::cmp::Reverse(id_of(id)));
    for old in ids.into_iter().skip(keep) {
        let _ = std::fs::remove_dir_all(root.join(old));
    }
}

/// 所有快照 id，按时间从旧到新
pub fn ids(root: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<String> = rd
        .flatten()
        .filter(|e| e.path().join("manifest.json").is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    out.sort_by_key(|id| id_of(id));
    out
}

pub fn latest(root: &Path) -> Option<String> {
    ids(root).pop()
}

pub fn remove(root: &Path, id: &str) {
    let _ = std::fs::remove_dir_all(root.join(id));
}

#[derive(Debug)]
pub struct LoadedItem {
    pub path: String,
    pub root: String,
    pub name: String,
    pub before: Vec<u8>,
    pub after: Vec<u8>,
}

#[derive(Debug)]
pub struct Loaded {
    pub manifest: Manifest,
    pub items: Vec<LoadedItem>,
}

pub fn load(root: &Path, id: &str) -> Result<Loaded, String> {
    let dir = root.join(id);
    let raw = std::fs::read(dir.join("manifest.json"))
        .map_err(|e| format!("读快照清单失败：{e}"))?;
    let manifest: Manifest =
        serde_json::from_slice(&raw).map_err(|e| format!("快照清单损坏：{e}"))?;
    let mut items = Vec::with_capacity(manifest.entries.len());
    for (i, entry) in manifest.entries.iter().enumerate() {
        let before = std::fs::read(dir.join(format!("{i}.before")))
            .map_err(|e| format!("快照缺文件（{i}.before）：{e}"))?;
        let after = std::fs::read(dir.join(format!("{i}.after")))
            .map_err(|e| format!("快照缺文件（{i}.after）：{e}"))?;
        items.push(LoadedItem {
            path: entry.path.clone(),
            root: entry.root.clone(),
            name: entry.name.clone(),
            before,
            after,
        });
    }
    Ok(Loaded { manifest, items })
}

/// 交给 [`replace_plan::plan`] 做判断，这里只负责把两种结构对上
pub fn plan(loaded: &Loaded, current: impl FnMut(&str) -> Option<Vec<u8>>) -> replace_plan::UndoPlan {
    let items: Vec<replace_plan::Item<'_>> = loaded
        .items
        .iter()
        .map(|it| replace_plan::Item {
            path: it.path.as_str(),
            before: it.before.as_slice(),
            after: it.after.as_slice(),
        })
        .collect();
    replace_plan::plan(&items, current)
}
