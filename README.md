<h1 align="center">
  <img src="./src-tauri/icons/icon.png" alt="Clash Verge Rev" width="128" />
  <br />
  Clash Verge Rev · Karing 分流增强版
</h1>

<p align="center">
  基于 Clash Verge Rev 的桌面增强分支，提供完整分流管理、应用规则、连接与代理组联动，以及可审计的多平台发行流程。
</p>

<p align="center">
  <a href="https://github.com/kongzhilv/clash-verge-rev/actions/workflows/karing-diagnostics-once.yml">
    <img alt="桌面版发行状态" src="https://github.com/kongzhilv/clash-verge-rev/actions/workflows/karing-diagnostics-once.yml/badge.svg?branch=feature%2Fkaring-style-diversion" />
  </a>
  <a href="https://github.com/kongzhilv/clash-verge-rev/releases">
    <img alt="发行版本" src="https://img.shields.io/github/v/release/kongzhilv/clash-verge-rev?include_prereleases&sort=semver" />
  </a>
  <a href="./LICENSE">
    <img alt="许可证" src="https://img.shields.io/github/license/kongzhilv/clash-verge-rev" />
  </a>
</p>

> [!IMPORTANT]
> 这是个人维护的非官方分支，不代表 Clash Verge Rev 上游项目。发行包由本仓库 GitHub Actions 构建，不包含上游官方签名、Apple 公证或官方更新签名。

## 项目定位

本分支保留 Clash Verge Rev 的 Mihomo 桌面代理管理能力，并把规则、连接、应用/项目和代理组组织成同一套可追溯关系。

当前开发分支：`feature/karing-style-diversion`

支持平台：

- Windows x64、Windows ARM64
- macOS Apple Silicon、macOS Intel
- Linux x64、Linux ARM64、Linux ARMv7

Android 不在本分支的构建与发行范围内。

## 完整分流管理

本分支不再提供“简单模式”和“高级模式”两套界面。进入分流设置后直接显示完整能力：

- 全局分流启停、私有网络直连和机场规则优先级
- 当前选择、自动选择、直连、拦截、静默拦截或指定现有代理组
- 手动规则组的增删、排序、条件逻辑和匹配条件
- 域名、IP/CIDR、端口、进程名、进程路径、GeoSite、GeoIP 和 Rule Set
- 应用规则及其托管规则组

旧配置中的 `ui-mode: simple` 会在读取和重新保存时自动清理，不需要手工迁移。

## 应用分流档案

应用规则用于解决 Mihomo 无法稳定返回进程信息时的分流问题。每个档案可保存：

- 应用名称
- 一个或多个应用完整路径
- 域名或域名后缀
- 目标 IP/CIDR
- 目标端口或端口范围
- 关联的处理动作或现有代理组

桌面端可通过系统文件选择器直接选择可执行文件；软件会同时登记完整路径和文件名。

保存应用规则后，软件会生成一个真实的 Mihomo 分流规则组，而不是只在界面里做标签。匹配优先级为：

1. 完整应用路径
2. 应用名称
3. 域名
4. 目标 IP/CIDR
5. 目标端口辅助条件

当运行时没有进程名或路径时，连接页会根据已登记的域名和 IP 特征推断所属项目，并明确标注“特征推断”。实际路由仍由编译后的 Mihomo 规则完成。

## 规则、连接与代理组联动

### 从连接出发

连接详情会同时显示：

- Mihomo 返回的进程名和进程路径
- 软件识别或推断出的应用/项目
- 对应托管规则组
- 预期出口代理组
- 实际命中规则和实际出口链

可直接从一条连接：

- 新建应用规则
- 编辑已识别的档案
- 将单个域名、IP、端口或进程条件加入手动规则组
- 跳转到对应规则或代理组

### 从规则出发

规则页顶部显示应用规则关系，包含识别连接数、出口连接数、托管规则组和目标代理组。点击应用规则可直接打开完整编辑界面。

### 从代理组出发

应用规则指定出口策略后，可从应用规则卡片跳转到该代理组。代理组页会显示：

- 使用该代理组的应用/项目
- 当前选择节点
- 候选节点数量
- 该代理组当前承载的连接
- 直接切换节点的选择器

### 从连接列表筛选

连接页支持按以下内容搜索和筛选：

- 域名与目标 IP
- Mihomo 返回的应用名称和应用路径
- 软件识别的应用/项目名称与说明
- 预期出口代理组

## 保存后立即生效

分流配置保存时会经过以下流程：

1. 同步应用规则和托管规则组。
2. 序列化到 `x-karing-diversion`。
3. 校验 Merge 配置。
4. 重新生成 Mihomo 运行时配置。
5. 热加载新配置；失败时使用核心重启兜底。
6. 关闭相关活动连接，使下一次连接重新匹配。

正常情况下无需重启软件。

## 代理总开关

软件启动后代理核心保持关闭，不会因为打开软件而自动连接。只有用户主动打开主页总开关后才启动 Mihomo。启动时会清理遗留的活动系统代理，同时保留节点、TUN 和分流设置。

## 下载与安装

请从本仓库 Releases 页面下载，并核对同一 Release 中的 `SHA256SUMS.txt`。

| 系统 | 架构 | 推荐文件类型 | 说明 |
| --- | --- | --- | --- |
| Windows | x64 | `x64-setup.exe` | 绝大多数 Intel/AMD 电脑 |
| Windows | ARM64 | `arm64-setup.exe` | Windows ARM 设备 |
| Windows | x64/ARM64 | `fixed_webview2-setup.exe` | WebView2 异常时使用，体积更大 |
| macOS | Apple Silicon | `aarch64.dmg` | M 系列 Apple 芯片 |
| macOS | Intel | `x64.dmg` | Intel 处理器 Mac |
| Linux | x64 | `amd64.deb` / `x86_64.rpm` | 普通 64 位电脑 |
| Linux | ARM64 | `arm64.deb` / `aarch64.rpm` | 64 位 ARM 设备 |
| Linux | ARMv7 | `armhf.deb` / `armhfp.rpm` | 32 位 ARMv7 设备 |

> [!WARNING]
> 本分支发行包未使用上游官方签名。Windows SmartScreen、macOS Gatekeeper 或杀毒软件可能提示未知发布者，请先核对 SHA256。

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

构建指定平台：

```shell
node scripts/build-matching-service.mjs <目标三元组>
pnpm run prebuild <目标三元组>
pnpm tauri build --target <目标三元组>
```

常用目标三元组：

```text
x86_64-pc-windows-msvc
aarch64-pc-windows-msvc
x86_64-apple-darwin
aarch64-apple-darwin
x86_64-unknown-linux-gnu
aarch64-unknown-linux-gnu
armv7-unknown-linux-gnueabihf
```

## 发行审查

正式发行前，GitHub Actions 会执行：

1. Biome 格式检查
2. ESLint
3. TypeScript 类型检查
4. Knip 未使用代码报告
5. 前端生产构建
6. Rust Clippy
7. Windows、macOS、Linux 多架构安装包构建
8. 固定 WebView2 安装包构建
9. 12 个安装文件数量检查
10. SHA256 逐文件复核
11. Release 目标提交和 14 个资产完整性检查

Actions 页面中的工作流、作业和步骤使用中文显示名称；命令、变量、`job_id` 和矩阵字段保持英文。

## 问题反馈

提交问题时请附上操作系统、CPU 架构、安装包完整文件名、应用版本、提交号、复现步骤和脱敏日志。分流问题建议同时附上：

- 应用规则内容
- 预期规则和出口
- 实际命中规则与出口链
- Mihomo 是否返回进程名或进程路径
- 使用的系统代理/TUN 模式与 TUN stack

## 上游与致谢

- Clash Verge Rev
- Clash Verge
- Mihomo
- Karing
- Tauri
- Vite

感谢上游维护者和所有贡献者。

## 许可证

本项目遵循 [GPL-3.0-only](./LICENSE) 许可证。分发、修改或再发布时，请同时遵守上游项目及所用依赖的许可证要求。
