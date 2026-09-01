from pathlib import Path

WORKFLOW = Path('.github/workflows/karing-diagnostics-once.yml')
text = WORKFLOW.read_text(encoding='utf-8')

old_gate = """          check_contains .github/workflows/karing-diagnostics-once.yml 'id: linux-arm64' 'Linux ARM64 已纳入 native build matrix'
          check_contains .github/workflows/karing-diagnostics-once.yml 'os: ubuntu-22.04-arm' 'Linux ARM64 使用 GitHub 原生 ARM64 runner'
          check_not_contains .github/workflows/karing-diagnostics-once.yml 'deb_arch: arm64' 'Linux ARM64 不再使用 x64 multiarch apt'
"""
new_gate = """          python3 - <<'PY_MATRIX'
          from pathlib import Path

          workflow = Path('.github/workflows/karing-diagnostics-once.yml').read_text(encoding='utf-8')
          native_marker = '\\n  native-builds:\\n'
          next_marker = '\\n  linux-arm-builds:\\n'
          if native_marker not in workflow:
              raise SystemExit('[失败] 未找到 native-builds job')
          native = workflow.split(native_marker, 1)[1]
          if next_marker in native:
              native = native.split(next_marker, 1)[0]

          required = (
              ('id: linux-arm64', 'Linux ARM64 已纳入 native build matrix'),
              ('os: ubuntu-22.04-arm', 'Linux ARM64 使用 GitHub 原生 ARM64 runner'),
          )
          for needle, label in required:
              if needle not in native:
                  raise SystemExit(f'[失败] {label}：native-builds 中未找到 {needle}')
              print(f'[通过] {label}')

          if 'deb_arch: arm64' in native:
              raise SystemExit('[失败] Linux ARM64 native build matrix 仍包含 x64 multiarch deb_arch: arm64')
          print('[通过] Linux ARM64 不再使用 x64 multiarch apt')
          PY_MATRIX
"""

if old_gate not in text:
    raise SystemExit('Expected self-referential ARM64 scope gate not found; refusing broad rewrite')
text = text.replace(old_gate, new_gate, 1)

old_token = '          GH_TOKEN: ${{ github.token }}'
new_token = '          GH_TOKEN: ${{ secrets.KARING_RELEASE_TOKEN }}'
if old_token not in text:
    raise SystemExit('Expected release GH_TOKEN line not found; refusing broad rewrite')
text = text.replace(old_token, new_token, 1)

if "check_not_contains .github/workflows/karing-diagnostics-once.yml 'deb_arch: arm64'" in text:
    raise SystemExit('Self-referential ARM64 negative gate survived replacement')
if new_token not in text:
    raise SystemExit('KARING_RELEASE_TOKEN was not installed into publish-release')

WORKFLOW.write_text(text, encoding='utf-8')
print('Karing release workflow patch prepared and validated')
