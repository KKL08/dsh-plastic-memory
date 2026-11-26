import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

/** 模型选择表里一个选择键的文件（storage/sidecar.ts：`.state/model-selections/<sha1(选择键)>.json`）。 */
export function modelSelectionFile(root: string, key: string): string {
  return join(root, '.state', 'model-selections', `${createHash('sha1').update(key).digest('hex')}.json`)
}

/**
 * 让这个键的选择文件在、却读不出：bad-json 是手改坏了（半个文件也是这样），no-permission 是内容完好、没有读权限。
 * 返回文件路径和写进去的内容（断言文件没被改动用）。
 */
export async function breakModelSelection(root: string, key: string, how: 'bad-json' | 'no-permission'): Promise<{ path: string; text: string }> {
  const path = modelSelectionFile(root, key)
  const text = how === 'bad-json' ? '{"id":"' : JSON.stringify({ id: key, provider: 'provider-picked', model: 'model-picked' })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  if (how === 'no-permission') await chmod(path, 0o000)
  return { path, text }
}
