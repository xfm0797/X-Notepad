//! 撤销计划：纯逻辑，不碰磁盘，可以直接跑单测。
//!
//! 撤销全库替换时**不能**拿快照无脑盖回去：替换之后用户可能又改过那个文件，
//! 硬写会把后来的改动一起冲掉。所以这里只判断一件事——盘上现在的内容，
//! 还是不是当初替换写下的那一份（`after`）：
//!
//! - 一样 → 可以安全恢复成 `before`
//! - 不一样 → 后来又动过，跳过并说明原因
//! - 读不到 / 已经删了 → 跳过，别凭空把文件造回来
//! - 已经是 `before` → 什么都不用做，单独记一笔（不算失败）

#[derive(Debug, Clone)]
pub struct Item<'a> {
    pub path: &'a str,
    /// 替换前的原始字节
    pub before: &'a [u8],
    /// 替换当时写下的原始字节
    pub after: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UndoSkip {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Default)]
pub struct UndoPlan {
    /// 要恢复的下标（对应 `items`）
    pub restore: Vec<usize>,
    pub skipped: Vec<UndoSkip>,
    /// 盘上已经是替换前内容的文件数：不用动，也别报成失败
    pub already: u32,
}

/// `current` 返回文件现在的字节；读不到（删除 / 权限）返回 None。
pub fn plan(items: &[Item<'_>], mut current: impl FnMut(&str) -> Option<Vec<u8>>) -> UndoPlan {
    let mut out = UndoPlan::default();
    for (i, item) in items.iter().enumerate() {
        match current(item.path) {
            None => out.skipped.push(UndoSkip {
                path: item.path.to_string(),
                reason: "文件已删除".into(),
            }),
            Some(bytes) if bytes == item.before => out.already += 1,
            Some(bytes) if bytes == item.after => out.restore.push(i),
            Some(_) => out.skipped.push(UndoSkip {
                path: item.path.to_string(),
                reason: "替换后又被改过".into(),
            }),
        }
    }
    out
}
