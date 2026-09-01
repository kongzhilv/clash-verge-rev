from pathlib import Path
p = Path('src-tauri/src/core/windows_hotspot_ics.rs')
s = p.read_text(encoding='utf-8')
old = '        assert_eq!(super::hresult_symbol(0x80070057u32 as i32), "E_INVALIDARG");\n    }\n\n}\n'
new = '        assert_eq!(super::hresult_symbol(0x80070057u32 as i32), "E_INVALIDARG");\n    }\n}\n'
if old not in s:
    raise SystemExit('expected rustfmt-only tail not found')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
Path('.github/workflows/karing-v25-rustfmt-repair.yml').unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
