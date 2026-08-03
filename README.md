<h1 align="center">
  <img src="./src-tauri/icons/icon.png" alt="Clash Verge Rev" width="112" />
  <br />
  Clash Verge Rev · Karing 分流增强版
</h1>

<p align="center">
  基于 Clash Verge Rev 与 Mihomo 的桌面代理客户端增强分支。
  重点提供应用分流、连接归因、常用规则预设和可审计的多平台发行。
</p>

<p align="center">
  <a href="https://github.com/kongzhilv/clash-verge-rev/actions/workflows/karing-diagnostics-once.yml">
    <img alt="构建状态" src="https://github.com/kongzhilv/clash-verge-rev/actions/workflows/karing-diagnostics-once.yml/badge.svg?branch=feature%2Fkaring-style-diversion" />
  </a>
  <a href="https://github.com/kongzhilv/clash-verge-rev/releases">
    <img alt="发行版本" src="https://img.shields.io/github/v/release/kongzhilv/clash-verge-rev?include_prereleases&sort=semver" />
  </a>
  <a href="./LICENSE">
    <img alt="许可证" src="https://img.shields.io/github/license/kongzhilv/clash-verge-rev" />
  </a>
</p>

> [!IMPORTANT]
> 这是个人维护的非官方分支，不代表 Clash Verge Rev 上游项目。发行包没有上游官方签名或 Apple 公证，请使用 Release 中的 `SHA256SUMS.txt` 校验文件。

## 主要能力

### 应用分流

- 从当前联网应用直接创建分流规则。
- 支持应用名称、完整路径、域名和 IP/CIDR 条件。
- 出口可选择当前节点、自动选择、直连、拦截或已有代理组。
- 保存前执行 Mihomo 配置校验；失败自动恢复原配置。
- 保存后热应用配置并断开相关旧连接，使新连接重新匹配。

### Windows 连接归因

- 通过 Windows IP Helper API 读取 TCP/UDP IPv4/IPv6 连接与 PID。
- 通过 `QueryFullProcessImageNameW` 获取应用名称和完整 exe 路径。
- 普通连接优先匹配完整连接端点。
- TUN/Fake-IP 场景仅在源端口归属唯一时回退匹配，避免跨应用误判。
- 连接详情持续订阅最新数据，不会停留在点开时的旧快照。

### 连接工作区

- 搜索域名、IP、应用、规则和出口。
- 可按应用、命中规则或实际出口进行组合筛选。
- 详情按“应用 → 应用规则 → 预期出口 → 实际规则 → 实际出口”显示。
- 技术性连接参数默认折叠，主要操作固定在底部。

### 常用分流

分流中心提供可直接开关的常用规则：

- 中国大陆直连
- 境外网站代理
- 广告拦截
- 伊朗本地直连

每条预设都可以单独选择出口。更复杂的域名、GeoSite、GeoIP、Rule Set、端口和逻辑组合放在“通用规则”中维护。

## 界面结构

- **连接**：观察、搜索、筛选和诊断当前流量。
- **规则**：查看 Mihomo 实际规则，打开分流中心或域名测试。
- **分流中心**：维护应用分流、通用规则、常用预设和全局策略。
- **代理**：选择节点；只有从某个出口跳转时才显示该出口的应用上下文。

各页面不重复堆叠完整关系面板，内部托管规则组 ID 也不会暴露给普通用户。

## 下载

请从本仓库 [Releases](https://github.com/kongzhilv/clash-verge-rev/releases) 下载。

| 系统 | 架构 | 文件 |
| --- | --- | --- |
| Windows | x64 | `x64-setup.exe` |
| Windows | ARM64 | `arm64-setup.exe` |
| Windows | x64 / ARM64 | `fixed_webview2-setup.exe`，仅在系统 WebView2 异常时使用 |
| macOS | Apple Silicon | `aarch64.dmg` |
| macOS | Intel | `x64.dmg` |
| Linux | x64 | `amd64.deb` / `x86_64.rpm` |
| Linux | ARM64 | `arm64.deb` / `aarch64.rpm` |
| Linux | ARMv7 | `armhf.deb` / `armhfp.rpm` |

Android 不在本分支的构建范围内。

## 本地开发

建议环境：

- Node.js `24.18.0`
- pnpm `11.3.0`
- Rust `1.96.1`
- 对应平台的 Tauri 2 系统依赖

```shell
pnpm install --frozen-lockfile
pnpm run prebuild
pnpm dev
```

基础检查：

```shell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm knip:report
pnpm run web:build
cargo clippy --workspace --all-targets --features clippy -- -D warnings
```

## 发行门禁

正式发行必须完成：

1. Biome、ESLint、TypeScript、Knip 和前端生产构建。
2. Rustfmt、工作区 Clippy 和 Windows 原生 API 编译。
3. Windows、macOS、Linux 全架构安装器构建。
4. 固定 WebView2 x64 与 ARM64 安装器构建。
5. 恰好 12 个安装文件的数量检查和逐文件 SHA-256 校验。
6. Artifact 来源提交、摘要和有效期检查。
7. Release 标签精确指向已审查分支头。
8. Release 恰好包含 12 个安装文件及 `SHA256SUMS.txt`、`BUILD_INFO.txt`。

## 问题反馈

请附上：

- 操作系统和 CPU 架构
- 安装包完整文件名
- 应用版本与提交号
- 复现步骤
- 预期出口与实际命中规则/出口
- 是否使用系统代理或 TUN，以及 TUN stack
- 已脱敏的日志或诊断包

## 上游与致谢

感谢 Clash Verge Rev、Clash Verge、Mihomo、Karing、RustNet、Tauri 和 Vite 的维护者与贡献者。

## 许可证

本项目遵循 [GPL-3.0-only](./LICENSE)。Windows 连接归因参考 RustNet 的设计，第三方归属见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
