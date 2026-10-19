#!/usr/bin/env node
// 把 package.json 的宿主开发依赖改写到另一个 dsh 版本，供 CI 的下界档和升级前试新宿主用（改完要
// `pnpm install --no-frozen-lockfile`，改动不提交）。所有 @deepseek-ai/dsh-* 换成该版本；cordis、
// schemastery 换成该版本宿主 CLI 依赖的版本（宿主每次发版 vendor 的这两个包都可能升号）。
// host-common.sh 从 devDependencies 读宿主版本，所以之后的 host:smoke / host:contract 也跑这个版本。
//   用法：node scripts/use-host.cjs [版本]   省略版本 = peer 下界（dsh-tools 的 `>=x` 去掉 `>=`）
const fs = require('fs')
const { execFileSync } = require('child_process')
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const version = process.argv[2] ?? p.peerDependencies['@deepseek-ai/dsh-tools'].replace(/^>=/, '')
const hostDeps = JSON.parse(execFileSync('npm', ['view', `@deepseek-ai/dsh@${version}`, 'dependencies', '--json'], { encoding: 'utf8' }))
for (const name of Object.keys(p.devDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) p.devDependencies[name] = version
}
for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
  p.devDependencies[name] = hostDeps[name].replace(/^[~^]/, '')
}
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')
console.log(`use-host: dev dependencies now target dsh ${version} (cordis ${p.devDependencies['@deepseek-ai/cordis']}, schemastery ${p.devDependencies['@deepseek-ai/schemastery']})`)
