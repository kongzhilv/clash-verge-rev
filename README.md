<h1 align="center">
  <img src="./src-tauri/icons/icon.png" alt="Clash Verge Rev" width="128" />
  <br />
  Clash Verge Rev · Karing 分流增强版
</h1>

<p align="center">
  基于 Clash Verge Rev 的桌面增强分支，加入 Karing 风格分流管理、规则保存即时生效和可审计的多平台发行流程。
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
> 这是个人维护的非官方分支，不代表 Clash Verge Rev 上游项目。发行包使用本仓库的 GitHub Actions 构建，不包含上游官方签名、Apple 公证或官方更新签名。

## 项目定位

本项目保留 Clash Verge Rev 的桌面代理管理能力，并重点改进复杂规则分流的配置体验。

当前开发分支：`feature/karing-style-diversion`  
计划发行标签：`v2.5.3-karing`

适用平台：

- Windows x64、Windows ARM64
- macOS Apple Silicon、macOS Intel
- Linux x64、Linux ARM64、Linux ARMv7

Android 不在本分支的构建与发行范围内。

## 主要新增功能

### Karing 风格分流管理

- 在规则页面集中管理 Karing 风格分流配置。
- 支持保存和解析 `x-karing-diversion` 扩展配置。
- 支持 `x-karing-diversion-builtins` 内置分流匹配信息。
- 保存后的分流配置会重新参与运行时规则编译，而不是只写入配置文件。
- 保留 Clash Verge Rev 原有的 Merge、Script、Rules、Proxies 和 Groups 增强能力。

### 规则保存后立即生效

此前在当前配置选择了自定义 Merge 或 Script 时，修改全局 `Merge`/`Script` 可能被误判为“不影响当前运行时”，导致必须重启应用后才能看到新规则。

本分支已修正该链路：

1. 保存全局 `Merge` 或 `Script`。
2. 重新生成运行时配置。
3. 校验生成结果。
4. 调用 Mihomo 配置重载。
5. 如果热重载失败，则使用核心重启作为兜底。

正常情况下，无需重启 Clash Verge Rev，也无需手动重启 Mihomo。

可在日志中查找：

```text
[Karing] merge changed
[Karing] compile rules
[Karing] runtime regenerated and applied
```

### 主代理开关

本分支保留并审查了桌面主页的主代理启停链路，可直接调用后端：

```text
start_proxy
stop_proxy
```

该开关与系统代理、TUN 等具体模式的配置仍由 Clash Verge Rev 原有设置控制。

### 可审计发行流程

发行工作流会依次完成：

1. 前端格式、ESLint、TypeScript 和未使用代码检查。
2. Rust Clippy 检查。
3. Karing 分流关键代码审查。
4. 根据 `Cargo.lock` 中锁定的提交编译匹配版本服务组件。
5. 准备 Mihomo、GeoIP、GeoSite 等运行资源。
6. 构建各平台安装包。
7. 汇总安装包并生成 `SHA256SUMS.txt`。
8. 生成 `BUILD_INFO.txt`，记录分支、提交、版本和发行标签。
9. 校验产物数量后发布正式 GitHub Release。

## 下载与安装

发行完成后，请从本仓库的 [Releases 页面](https://github.com/kongzhilv/clash-verge-rev/releases) 下载，不要从来源不明的网盘或重新打包站点获取。

### 安装包选择

| 系统 | 架构 | 推荐文件类型 | 说明 |
| --- | --- | --- | --- |
| Windows | x64 | `x64-setup.exe` | 绝大多数 Intel/AMD 电脑选择此版本 |
| Windows | ARM64 | `arm64-setup.exe` | Windows ARM 设备使用 |
| Windows | x64/ARM64 | `fixed_webview2-setup.exe` | 系统无法正常安装或调用 WebView2 时使用，体积更大 |
| macOS | Apple Silicon | `aarch64.dmg` | M1、M2、M3、M4 等 Apple 芯片 |
| macOS | Intel | `x64.dmg` | Intel 处理器 Mac |
| Linux | x64 | `amd64.deb` / `x86_64.rpm` | 普通 64 位电脑 |
| Linux | ARM64 | `arm64.deb` / `aarch64.rpm` | 64 位 ARM 设备 |
| Linux | ARMv7 | `armhf.deb` / `armhfp.rpm` | 32 位 ARMv7 设备 |

> [!WARNING]
> 本分支发行包未使用上游官方签名。Windows SmartScreen、macOS Gatekeeper 或部分杀毒软件可能提示未知发布者。请先核对 Release 中的 `SHA256SUMS.txt`，并确认下载来源是本仓库。

## Karing 分流使用方法

1. 安装并启动本分支发行版。
2. 导入或选择一个可正常使用的 Mihomo 配置。
3. 进入规则页面，打开 Karing 分流管理。
4. 添加、修改、启用、停用或调整分流规则。
5. 保存配置。
6. 通过连接记录、规则命中情况或运行日志确认新规则已经应用。

保存完成后不应再需要重启应用。若规则没有按预期命中，优先检查：

- 规则顺序和优先级是否正确。
- 域名、IP、进程或规则集条件是否符合实际流量。
- 当前选中的配置是否已经成功启用。
- Mihomo 日志中是否存在配置校验或重载错误。
- 代理组名称是否与配置中的实际名称一致。

## 上游原有能力

- 基于 Rust、Tauri 2 和 React。
- 内置 Mihomo，并支持稳定版与 Alpha 内核。
- 系统代理、TUN 模式和服务模式。
- 配置订阅、Merge、Script 和可视化规则编辑。
- 节点、代理组、连接和日志管理。
- WebDAV 配置备份与同步。
- 自定义主题、托盘图标和 CSS 注入。

## 本地开发

### 建议环境

- Node.js：`24.18.0`
- pnpm：`11.3.0`
- Rust：`1.96.1`
- 已安装对应平台的 Tauri 2 系统依赖

### 安装依赖

```shell
pnpm install --frozen-lockfile
```

### 准备本机运行资源

```shell
pnpm run prebuild
```

### 启动开发模式

```shell
pnpm dev
```

### 构建指定平台

先根据 `Cargo.lock` 锁定的版本编译匹配服务组件：

```shell
node scripts/build-matching-service.mjs <目标三元组>
```

再准备 Mihomo 和其他运行资源：

```shell
pnpm run prebuild <目标三元组>
```

最后执行 Tauri 构建：

```shell
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

## GitHub Actions

本分支对 Actions 页面中的工作流、作业和步骤使用中文显示名称，便于直接定位失败阶段。核心流程包括：

- `桌面版发行与发布`
- `前端检查`
- `Rust 格式检查`
- `Rust Clippy 检查`

命令、变量、`job_id` 和矩阵字段仍保持英文，以保证 GitHub Actions 表达式和依赖关系稳定。

## 问题反馈

提交问题时请尽量附上：

- 操作系统和 CPU 架构。
- 安装包完整文件名。
- 应用版本与提交号。
- 问题复现步骤。
- 相关日志，但请先删除订阅地址、代理节点、令牌、Cookie 和个人路径等敏感信息。
- 分流问题建议附上预期规则、实际命中规则和对应目标域名或进程。

## 上游与致谢

本项目基于或使用以下项目：

- [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev)
- [Clash Verge](https://github.com/zzzgydi/clash-verge)
- [Mihomo](https://github.com/MetaCubeX/mihomo)
- [Tauri](https://github.com/tauri-apps/tauri)
- [Vite](https://github.com/vitejs/vite)

感谢上游维护者和所有贡献者。

## 许可证

本项目遵循 [GPL-3.0-only](./LICENSE) 许可证。对本分支进行分发、修改或再发布时，请同时遵守上游项目及所用依赖的许可证要求。
