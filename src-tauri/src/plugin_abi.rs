//! 插件 ABI 版本协商（纯逻辑，不碰 wasmtime）
//!
//! 两代 ABI 共存在同一个目录里，靠文件头区分：
//!
//! | 文件头 | 版本 | 形态 |
//! | --- | --- | --- |
//! | `\0asm 01 00 00 00` | v1 | 核心 wasm 模块（`alloc` / `run` / `result_len`） |
//! | `\0asm 0d 00 01 00` | v2 | 组件（Component Model，按 `wit/plugin.wit`） |
//!
//! `plugin.json` 里的 `abi` 字段是用来给人和市场看的；真正跑哪条路径以文件头为准，
//! 只有两类情况会直接拒绝：声明了宿主不认识的版本，或者声明 v2 却给了 v1 的核心模块
//! （那多半是忘了跑 `wrap-component`）。

/// 手写指针协议的核心模块
pub const ABI_LEGACY: u32 = 1;
/// Component Model 组件
pub const ABI_COMPONENT: u32 = 2;

/// 核心模块头：`\0asm` + 版本 1
pub const CORE_HEADER: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
/// 组件头：`\0asm` + 版本 0x0d + layer 1
pub const COMPONENT_HEADER: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Binary {
    /// v1 核心模块
    Core,
    /// v2 组件
    Component,
    /// 不是 wasm（截断 / 别的东西改名过来的）
    Unknown,
}

/// 只看前 8 个字节判断形态
pub fn detect(bytes: &[u8]) -> Binary {
    if bytes.len() < 8 {
        return Binary::Unknown;
    }
    if bytes[..8] == CORE_HEADER {
        Binary::Core
    } else if bytes[..8] == COMPONENT_HEADER {
        Binary::Component
    } else {
        Binary::Unknown
    }
}

/// 声明版本 + 文件头 → 实际执行形态
pub fn negotiate(declared: u32, binary: Binary) -> Result<Binary, String> {
    if declared != ABI_LEGACY && declared != ABI_COMPONENT {
        return Err(format!(
            "插件声明 ABI v{declared}，宿主只支持 v1（核心模块）和 v2（组件）"
        ));
    }
    match binary {
        Binary::Unknown => Err("插件文件不是 wasm（文件头不是 \\0asm）".to_string()),
        // 声明 v2 却给了核心模块：几乎都是漏了把模块包成组件这一步
        Binary::Core if declared == ABI_COMPONENT => Err(
            "插件声明 ABI v2，但 plugin.wasm 是 v1 核心模块；重新打包时要用 tools/wrap-component 包成组件"
                .to_string(),
        ),
        other => Ok(other),
    }
}

/// 给前端展示用：文件就位时以文件头为准，否则回落到 plugin.json 的声明
pub fn effective_abi(declared: u32, binary: Binary) -> u32 {
    match binary {
        Binary::Component => ABI_COMPONENT,
        Binary::Core => ABI_LEGACY,
        Binary::Unknown => declared,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(version: [u8; 4]) -> Vec<u8> {
        let mut out = vec![0x00, 0x61, 0x73, 0x6d];
        out.extend_from_slice(&version);
        out.extend_from_slice(b"junk tail");
        out
    }

    #[test]
    fn detects_core_module() {
        assert_eq!(detect(&header([0x01, 0x00, 0x00, 0x00])), Binary::Core);
    }

    #[test]
    fn detects_component() {
        assert_eq!(detect(&header([0x0d, 0x00, 0x01, 0x00])), Binary::Component);
    }

    #[test]
    fn short_or_foreign_is_unknown() {
        assert_eq!(detect(&[]), Binary::Unknown);
        assert_eq!(detect(b"\0asm\x01\x00"), Binary::Unknown);
        assert_eq!(detect(b"PK\x03\x04npm-package"), Binary::Unknown);
        // 自定义节 / 未知版本号都不算
        assert_eq!(detect(&header([0x02, 0x00, 0x00, 0x00])), Binary::Unknown);
    }

    #[test]
    fn negotiates_both_generations() {
        assert_eq!(negotiate(1, Binary::Core), Ok(Binary::Core));
        assert_eq!(negotiate(2, Binary::Component), Ok(Binary::Component));
        // 文件头说了算：manifest 落后于产物不该拦住运行
        assert_eq!(negotiate(1, Binary::Component), Ok(Binary::Component));
    }

    #[test]
    fn rejects_declared_v2_with_core_binary() {
        let err = negotiate(2, Binary::Core).unwrap_err();
        assert!(err.contains("wrap-component"), "{err}");
    }

    #[test]
    fn rejects_unknown_declared_version() {
        let err = negotiate(3, Binary::Component).unwrap_err();
        assert!(err.contains("v3"), "{err}");
        assert_eq!(negotiate(0, Binary::Core).is_err(), true);
    }

    #[test]
    fn rejects_garbage_binary() {
        assert!(negotiate(2, Binary::Unknown).is_err());
        assert!(negotiate(1, Binary::Unknown).is_err());
    }

    #[test]
    fn effective_abi_prefers_binary() {
        assert_eq!(effective_abi(1, Binary::Component), ABI_COMPONENT);
        assert_eq!(effective_abi(2, Binary::Core), ABI_LEGACY);
        assert_eq!(effective_abi(2, Binary::Unknown), ABI_COMPONENT);
        assert_eq!(effective_abi(1, Binary::Unknown), ABI_LEGACY);
    }
}
