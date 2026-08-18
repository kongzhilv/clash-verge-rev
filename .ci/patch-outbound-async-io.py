from pathlib import Path

path = Path('src-tauri/src/core/outbound_diagnostics.rs')
text = path.read_text(encoding='utf-8')
old = '''use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
'''
new = '''use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    path::PathBuf,
'''
if text.count(old) != 1:
    raise SystemExit('import anchor mismatch')
text = text.replace(old, new)
old2 = '''        let content = match fs::read_to_string(path) {
            Ok(content) => content,
            Err(_) => continue,
        };
'''
new2 = '''        let content = match tokio::fs::read_to_string(path).await {
            Ok(content) => content,
            Err(_) => continue,
        };
'''
if text.count(old2) != 1:
    raise SystemExit('read_to_string anchor mismatch')
text = text.replace(old2, new2)
path.write_text(text, encoding='utf-8')
