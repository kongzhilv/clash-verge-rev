// Compatibility entrypoint retained for existing workflows and external callers.
// The v26 policy that forbade HNetCfg mutation for Windows Mobile Hotspot was
// invalidated by packet captures and the validated TUN-as-ICS-PUBLIC topology.
// v27 is now the authoritative, generic safety contract.
await import('./check-windows-tun-safety-v27.mjs')
