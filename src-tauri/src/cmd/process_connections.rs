use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessConnection {
    pub pid: u32,
    pub process_name: String,
    pub process_path: String,
    pub protocol: String,
    pub local_address: String,
    pub remote_address: Option<String>,
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessConnectionSnapshot {
    pub supported: bool,
    pub source: String,
    pub connections: Vec<ProcessConnection>,
    pub errors: Vec<String>,
}

pub(super) fn get_process_connections() -> ProcessConnectionSnapshot {
    #[cfg(target_os = "windows")]
    {
        windows_impl::collect()
    }

    #[cfg(not(target_os = "windows"))]
    {
        ProcessConnectionSnapshot {
            supported: false,
            source: "当前平台暂未接入系统连接归因".to_string(),
            connections: Vec::new(),
            errors: Vec::new(),
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{ProcessConnection, ProcessConnectionSnapshot};
    use anyhow::{Result, anyhow};
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6};
    use std::os::windows::ffi::OsStringExt as _;
    use windows::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, WIN32_ERROR};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID,
        MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
        MIB_UDP6ROW_OWNER_PID, MIB_UDP6TABLE_OWNER_PID, MIB_UDPROW_OWNER_PID,
        MIB_UDPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };

    const MAX_TABLE_BYTES: u32 = 100_000_000;

    #[derive(Clone)]
    struct ProcessIdentity {
        name: String,
        path: String,
    }

    pub(super) fn collect() -> ProcessConnectionSnapshot {
        let mut connections = Vec::new();
        let mut identities = HashMap::new();
        let mut errors = Vec::new();

        collect_result(
            "TCP IPv4",
            collect_tcp_v4(&mut connections, &mut identities),
            &mut errors,
        );
        collect_result(
            "TCP IPv6",
            collect_tcp_v6(&mut connections, &mut identities),
            &mut errors,
        );
        collect_result(
            "UDP IPv4",
            collect_udp_v4(&mut connections, &mut identities),
            &mut errors,
        );
        collect_result(
            "UDP IPv6",
            collect_udp_v6(&mut connections, &mut identities),
            &mut errors,
        );

        connections.sort_by(|left, right| {
            left.process_path
                .to_lowercase()
                .cmp(&right.process_path.to_lowercase())
                .then_with(|| left.process_name.cmp(&right.process_name))
                .then_with(|| left.pid.cmp(&right.pid))
                .then_with(|| left.protocol.cmp(&right.protocol))
                .then_with(|| left.local_address.cmp(&right.local_address))
                .then_with(|| left.remote_address.cmp(&right.remote_address))
        });
        connections.dedup_by(|left, right| {
            left.pid == right.pid
                && left.protocol == right.protocol
                && left.local_address == right.local_address
                && left.remote_address == right.remote_address
        });

        ProcessConnectionSnapshot {
            supported: true,
            source: "RustNet Windows 归因链（IP Helper API）".to_string(),
            connections,
            errors,
        }
    }

    fn collect_result(label: &str, result: Result<()>, errors: &mut Vec<String>) {
        if let Err(error) = result {
            errors.push(format!("{label}: {error}"));
        }
    }

    fn allocate_table_buffer(size: u32) -> Result<Vec<u32>> {
        if size == 0 || size > MAX_TABLE_BYTES {
            return Err(anyhow!("系统返回了异常缓冲区大小：{size}"));
        }
        Ok(vec![
            0;
            (size as usize).div_ceil(std::mem::size_of::<u32>())
        ])
    }

    fn table_buffer_len(table: &[u32]) -> usize {
        std::mem::size_of_val(table)
    }

    fn process_identity(
        pid: u32,
        identities: &mut HashMap<u32, ProcessIdentity>,
    ) -> Option<ProcessIdentity> {
        if pid == 0 {
            return None;
        }
        Some(
            identities
                .entry(pid)
                .or_insert_with(|| query_process_identity(pid))
                .clone(),
        )
    }

    fn query_process_identity(pid: u32) -> ProcessIdentity {
        unsafe {
            let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(handle) => handle,
                Err(_) => return fallback_identity(pid),
            };

            let mut size = 32_768_u32;
            let mut buffer = vec![0_u16; size as usize];
            let result = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(handle);

            if result.is_err() || size == 0 {
                return fallback_identity(pid);
            }

            let path = OsString::from_wide(&buffer[..size as usize])
                .to_string_lossy()
                .to_string();
            let name = path
                .rsplit(['\\', '/'])
                .next()
                .filter(|value| !value.is_empty())
                .map_or_else(|| format!("PID {pid}"), ToString::to_string);

            ProcessIdentity { name, path }
        }
    }

    fn fallback_identity(pid: u32) -> ProcessIdentity {
        ProcessIdentity {
            name: if pid == 4 {
                "System".to_string()
            } else {
                format!("PID {pid}")
            },
            path: String::new(),
        }
    }

    fn tcp_state(value: u32) -> String {
        match value {
            1 => "CLOSED".to_string(),
            2 => "LISTEN".to_string(),
            3 => "SYN-SENT".to_string(),
            4 => "SYN-RECEIVED".to_string(),
            5 => "ESTABLISHED".to_string(),
            6 => "FIN-WAIT-1".to_string(),
            7 => "FIN-WAIT-2".to_string(),
            8 => "CLOSE-WAIT".to_string(),
            9 => "CLOSING".to_string(),
            10 => "LAST-ACK".to_string(),
            11 => "TIME-WAIT".to_string(),
            12 => "DELETE-TCB".to_string(),
            _ => format!("UNKNOWN({value})"),
        }
    }

    fn collect_tcp_v4(
        connections: &mut Vec<ProcessConnection>,
        identities: &mut HashMap<u32, ProcessIdentity>,
    ) -> Result<()> {
        unsafe {
            let mut size = 0_u32;
            let first = GetExtendedTcpTable(
                None,
                &mut size,
                false,
                AF_INET.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            if WIN32_ERROR(first) != ERROR_INSUFFICIENT_BUFFER {
                return Err(anyhow!("首次读取返回代码 {first}"));
            }

            let mut table = allocate_table_buffer(size)?;
            let second = GetExtendedTcpTable(
                Some(table.as_mut_ptr() as *mut _),
                &mut size,
                false,
                AF_INET.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            if second != 0 {
                return Err(anyhow!("读取连接表返回代码 {second}"));
            }

            let tcp_table = &*(table.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
            let count = tcp_table.dwNumEntries as usize;
            let required = std::mem::size_of::<u32>()
                + count * std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
            if table_buffer_len(&table) < required {
                return Err(anyhow!("连接表长度不足：{} < {required}", table_buffer_len(&table)));
            }

            let rows = &tcp_table.table[0] as *const MIB_TCPROW_OWNER_PID;
            for index in 0..count {
                let row = &*rows.add(index);
                let Some(identity) = process_identity(row.dwOwningPid, identities) else {
                    continue;
                };
                let local = SocketAddr::new(
                    IpAddr::V4(Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes())),
                    u16::from_be(row.dwLocalPort as u16),
                );
                let remote = SocketAddr::new(
                    IpAddr::V4(Ipv4Addr::from(row.dwRemoteAddr.to_ne_bytes())),
                    u16::from_be(row.dwRemotePort as u16),
                );
                connections.push(ProcessConnection {
                    pid: row.dwOwningPid,
                    process_name: identity.name,
                    process_path: identity.path,
                    protocol: "TCP".to_string(),
                    local_address: local.to_string(),
                    remote_address: (remote.port() != 0).then(|| remote.to_string()),
                    state: Some(tcp_state(row.dwState)),
                });
            }
        }
        Ok(())
    }

    fn collect_tcp_v6(
        connections: &mut Vec<ProcessConnection>,
        identities: &mut HashMap<u32, ProcessIdentity>,
    ) -> Result<()> {
        unsafe {
            let mut size = 0_u32;
            let first = GetExtendedTcpTable(
                None,
                &mut size,
                false,
                AF_INET6.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            if WIN32_ERROR(first) != ERROR_INSUFFICIENT_BUFFER {
                return Err(anyhow!("首次读取返回代码 {first}"));
            }

            let mut table = allocate_table_buffer(size)?;
            let second = GetExtendedTcpTable(
                Some(table.as_mut_ptr() as *mut _),
                &mut size,
                false,
                AF_INET6.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            if second != 0 {
                return Err(anyhow!("读取连接表返回代码 {second}"));
            }

            let tcp_table = &*(table.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID);
            let count = tcp_table.dwNumEntries as usize;
            let required = std::mem::size_of::<u32>()
                + count * std::mem::size_of::<MIB_TCP6ROW_OWNER_PID>();
            if table_buffer_len(&table) < required {
                return Err(anyhow!("连接表长度不足：{} < {required}", table_buffer_len(&table)));
            }

            let rows = &tcp_table.table[0] as *const MIB_TCP6ROW_OWNER_PID;
            for index in 0..count {
                let row = &*rows.add(index);
                let Some(identity) = process_identity(row.dwOwningPid, identities) else {
                    continue;
                };
                let local = SocketAddr::V6(SocketAddrV6::new(
                    Ipv6Addr::from(row.ucLocalAddr),
                    u16::from_be(row.dwLocalPort as u16),
                    0,
                    row.dwLocalScopeId,
                ));
                let remote = SocketAddr::V6(SocketAddrV6::new(
                    Ipv6Addr::from(row.ucRemoteAddr),
                    u16::from_be(row.dwRemotePort as u16),
                    0,
                    row.dwRemoteScopeId,
                ));
                connections.push(ProcessConnection {
                    pid: row.dwOwningPid,
                    process_name: identity.name,
                    process_path: identity.path,
                    protocol: "TCP".to_string(),
                    local_address: local.to_string(),
                    remote_address: (remote.port() != 0).then(|| remote.to_string()),
                    state: Some(tcp_state(row.dwState)),
                });
            }
        }
        Ok(())
    }

    fn collect_udp_v4(
        connections: &mut Vec<ProcessConnection>,
        identities: &mut HashMap<u32, ProcessIdentity>,
    ) -> Result<()> {
        unsafe {
            let mut size = 0_u32;
            let first = GetExtendedUdpTable(
                None,
                &mut size,
                false,
                AF_INET.0 as u32,
                UDP_TABLE_OWNER_PID,
                0,
            );
            if WIN32_ERROR(first) != ERROR_INSUFFICIENT_BUFFER {
                return Err(anyhow!("首次读取返回代码 {first}"));
            }

            let mut table = allocate_table_buffer(size)?;
            let second = GetExtendedUdpTable(
                Some(table.as_mut_ptr() as *mut _),
                &mut size,
                false,
                AF_INET.0 as u32,
                UDP_TABLE_OWNER_PID,
                0,
            );
            if second != 0 {
                return Err(anyhow!("读取连接表返回代码 {second}"));
            }

            let udp_table = &*(table.as_ptr() as *const MIB_UDPTABLE_OWNER_PID);
            let count = udp_table.dwNumEntries as usize;
            let required = std::mem::size_of::<u32>()
                + count * std::mem::size_of::<MIB_UDPROW_OWNER_PID>();
            if table_buffer_len(&table) < required {
                return Err(anyhow!("连接表长度不足：{} < {required}", table_buffer_len(&table)));
            }

            let rows = &udp_table.table[0] as *const MIB_UDPROW_OWNER_PID;
            for index in 0..count {
                let row = &*rows.add(index);
                let Some(identity) = process_identity(row.dwOwningPid, identities) else {
                    continue;
                };
                let local = SocketAddr::new(
                    IpAddr::V4(Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes())),
                    u16::from_be(row.dwLocalPort as u16),
                );
                connections.push(ProcessConnection {
                    pid: row.dwOwningPid,
                    process_name: identity.name,
                    process_path: identity.path,
                    protocol: "UDP".to_string(),
                    local_address: local.to_string(),
                    remote_address: None,
                    state: None,
                });
            }
        }
        Ok(())
    }

    fn collect_udp_v6(
        connections: &mut Vec<ProcessConnection>,
        identities: &mut HashMap<u32, ProcessIdentity>,
    ) -> Result<()> {
        unsafe {
            let mut size = 0_u32;
            let first = GetExtendedUdpTable(
                None,
                &mut size,
                false,
                AF_INET6.0 as u32,
                UDP_TABLE_OWNER_PID,
                0,
            );
            if WIN32_ERROR(first) != ERROR_INSUFFICIENT_BUFFER {
                return Err(anyhow!("首次读取返回代码 {first}"));
            }

            let mut table = allocate_table_buffer(size)?;
            let second = GetExtendedUdpTable(
                Some(table.as_mut_ptr() as *mut _),
                &mut size,
                false,
                AF_INET6.0 as u32,
                UDP_TABLE_OWNER_PID,
                0,
            );
            if second != 0 {
                return Err(anyhow!("读取连接表返回代码 {second}"));
            }

            let udp_table = &*(table.as_ptr() as *const MIB_UDP6TABLE_OWNER_PID);
            let count = udp_table.dwNumEntries as usize;
            let required = std::mem::size_of::<u32>()
                + count * std::mem::size_of::<MIB_UDP6ROW_OWNER_PID>();
            if table_buffer_len(&table) < required {
                return Err(anyhow!("连接表长度不足：{} < {required}", table_buffer_len(&table)));
            }

            let rows = &udp_table.table[0] as *const MIB_UDP6ROW_OWNER_PID;
            for index in 0..count {
                let row = &*rows.add(index);
                let Some(identity) = process_identity(row.dwOwningPid, identities) else {
                    continue;
                };
                let local = SocketAddr::V6(SocketAddrV6::new(
                    Ipv6Addr::from(row.ucLocalAddr),
                    u16::from_be(row.dwLocalPort as u16),
                    0,
                    row.dwLocalScopeId,
                ));
                connections.push(ProcessConnection {
                    pid: row.dwOwningPid,
                    process_name: identity.name,
                    process_path: identity.path,
                    protocol: "UDP".to_string(),
                    local_address: local.to_string(),
                    remote_address: None,
                    state: None,
                });
            }
        }
        Ok(())
    }
}
