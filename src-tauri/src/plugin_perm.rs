//! 插件能力声明（permission）。
//!
//! 沙箱里能做的事只有三件，都在 `wit/plugin.wit` 的 `host` 接口里：
//! `log` / `now-ms` / `read-setting`。默认**一件都不给**——插件得在
//! `plugin.json` 的 `permissions` 里显式列出要用的能力，安装时前端也会先提示一遍。
//!
//! 缺省规则之所以分两代：v1 插件是 0.11 之前装的，那时候宿主本来就一直提供
//! `log` / `now_ms`，卡死它们等于把老插件废掉；v2 是新的，从零开始最干净。
//!
//! ```json
//! { "abi": 2, "permissions": ["log", "read-setting"] }
//! ```

// 关掉 wasm-plugins 时只有 list() 用到这个模块，允许校验相关的方法暂时没人用
#![cfg_attr(not(feature = "wasm-plugins"), allow(dead_code))]

/// 写日志（`host.log`）
pub const LOG: &str = "log";
/// 取当前时间戳（`host.now-ms`）
pub const NOW_MS: &str = "now-ms";
/// 读用户设置（`host.read-setting`）
pub const READ_SETTING: &str = "read-setting";

/// 宿主认识的全部能力。写错的键不会生效，但会单独挑出来提醒作者。
pub const KNOWN: [&str; 3] = [LOG, NOW_MS, READ_SETTING];

/// v1 的历史行为：一直有 log 与 now_ms
const LEGACY_DEFAULT: [&str; 2] = [LOG, NOW_MS];

/// 一次运行被授予的能力集合
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Grant {
    keys: Vec<String>,
    unknown: Vec<String>,
}

impl Grant {
    /// `declared` 为 `None` 表示清单里根本没写 `permissions`，按 ABI 默认；
    /// 写成 `[]` 则是「什么都不要」，和 `None` 不是一回事。
    pub fn resolve(declared: Option<&[String]>, abi: u32) -> Self {
        let raw: Vec<String> = match declared {
            Some(list) => list.to_vec(),
            None if abi >= 2 => Vec::new(),
            None => LEGACY_DEFAULT.iter().map(|s| s.to_string()).collect(),
        };

        let mut keys: Vec<String> = Vec::new();
        let mut unknown: Vec<String> = Vec::new();
        for item in raw {
            let key = item.trim().to_ascii_lowercase();
            if key.is_empty() {
                continue;
            }
            if !KNOWN.contains(&key.as_str()) {
                if !unknown.contains(&key) {
                    unknown.push(key);
                }
                continue;
            }
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        Self { keys, unknown }
    }

    pub fn allows(&self, key: &str) -> bool {
        self.keys.iter().any(|k| k == key)
    }

    pub fn keys(&self) -> &[String] {
        &self.keys
    }

    /// 清单里写了但宿主不认识的能力名（多半是拼错了）
    pub fn unknown(&self) -> &[String] {
        &self.unknown
    }

}

/// 被拒之后的统一报错：说清缺哪个、怎么补
pub fn denial_message(denied: &[String]) -> String {
    let list = denied.join(" / ");
    format!("插件调用了没声明的能力：{list}（在 plugin.json 的 permissions 里补上再重装）")
}

/// 清单里出现不认识的键时给作者的提醒；不拦运行，只是提示
pub fn unknown_message(unknown: &[String]) -> String {
    format!(
        "plugin.json 里的能力名认不出来：{}（可用的是 {}）",
        unknown.join(" / "),
        KNOWN.join(" / ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn v2_without_field_gets_nothing() {
        let g = Grant::resolve(None, 2);
        assert!(g.keys().is_empty());
        assert!(!g.allows(LOG) && !g.allows(READ_SETTING));
    }

    #[test]
    fn legacy_without_field_keeps_old_defaults() {
        let g = Grant::resolve(None, 1);
        assert!(g.allows(LOG) && g.allows(NOW_MS));
        assert!(!g.allows(READ_SETTING));
        assert!(g.unknown().is_empty());
    }

    #[test]
    fn explicit_empty_list_means_none_even_for_legacy() {
        let empty: Vec<String> = Vec::new();
        let g = Grant::resolve(Some(&empty), 1);
        assert!(g.keys().is_empty());
    }

    #[test]
    fn normalizes_case_space_and_dupes() {
        let g = Grant::resolve(Some(&strs(&[" Log ", "log", "READ-setting", ""])), 2);
        assert_eq!(g.keys(), ["log", "read-setting"]);
    }

    #[test]
    fn unknown_keys_do_not_grant_anything() {
        let g = Grant::resolve(Some(&strs(&["network", "log"])), 2);
        assert_eq!(g.keys(), ["log"]);
        assert_eq!(g.unknown(), ["network"]);
    }

    #[test]
    fn duplicate_unknown_keys_are_reported_once() {
        let g = Grant::resolve(Some(&strs(&["fs", "fs", "FS"])), 2);
        assert_eq!(g.unknown(), ["fs"]);
    }

    #[test]
    fn denial_message_names_the_capability() {
        let msg = denial_message(&strs(&["read-setting", "log"]));
        assert!(msg.contains("read-setting / log"), "{msg}");
        assert!(msg.contains("permissions"), "{msg}");
    }

    #[test]
    fn unknown_message_lists_known_set() {
        let msg = unknown_message(&strs(&["net"]));
        assert!(msg.contains("net"));
        assert!(msg.contains("read-setting"), "{msg}");
    }
}
