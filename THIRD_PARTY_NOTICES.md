# Third-party notices

## RustNet Windows process attribution

The Windows system-connection attribution implementation in
`src-tauri/src/cmd/process_connections.rs` is adapted from the architecture and
IP Helper API handling used by [RustNet](https://github.com/domcyrus/rustnet),
Copyright its contributors, licensed under the Apache License, Version 2.0.

The adapted implementation was modified for Clash Verge Rev to expose full
executable paths, aggregate TCP/UDP IPv4/IPv6 endpoints, and feed the existing
program/project diversion model. The repository remains distributed under
GPL-3.0-only; the Apache-2.0 attribution for the adapted portion is retained
here.

Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0
