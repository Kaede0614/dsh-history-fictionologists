/**
 * 测试公共辅助。
 *
 * 临时目录刻意放在**工作区内部**（`.tmp-tests/`）而不是系统 temp：
 * 受限沙箱（Windows ACL restricted token）只放行工作区的文件操作，
 * Node 对系统 temp 调 `mkdtempSync` 会直接 EPERM，测试会整片失败。
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
export const TMP_ROOT = join(ROOT, '.tmp-tests')

/** 在工作区内建一个唯一临时目录。 */
export function makeTmpDir(prefix) {
  mkdirSync(TMP_ROOT, { recursive: true })
  return mkdtempSync(join(TMP_ROOT, prefix))
}
