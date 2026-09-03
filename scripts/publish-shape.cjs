#!/usr/bin/env node
// 把 package.json 改写成发布形状（唯一定义，host-common.sh 打包前调用；与 publishConfig 的结果一致）：
//   main 指向编译产物、files 白名单只含 lib/cordis.patch.yml/README，其余字段（含 scripts、devDependencies、
//   packageManager、prepublishOnly）原样保留供贡献者使用；只删掉依赖私有 e2e/ 的脚本。
//   用法：node scripts/publish-shape.cjs <in package.json> <out package.json>
const fs = require('fs')
const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: publish-shape.cjs <in package.json> <out package.json>')
  process.exit(2)
}
const p = JSON.parse(fs.readFileSync(input, 'utf8'))
const out = { ...p, main: 'lib/index.js', files: ['lib', 'cordis.patch.yml', 'README.md'] }
out.scripts = Object.fromEntries(Object.entries(p.scripts ?? {}).filter(([k]) => !k.includes('e2e')))
fs.writeFileSync(output, JSON.stringify(out, null, 2) + '\n')
