#!/usr/bin/env node
// 把 package.json 改写成发布形状（唯一定义，host-common.sh 打包前调用；与 publishConfig 的结果一致）：
//   main 与 exports 指向编译产物（exports 取 publishConfig.exports）、files 白名单只含 lib/locale/插件图标/cordis.patch.yml/README/第三方许可声明，其余字段（含 scripts、devDependencies、
//   packageManager、prepublishOnly）原样保留供贡献者使用；只删掉依赖私有 e2e/ 的脚本。
//   optionalDependencies（@node-rs/jieba）原样保留；--without-optional 去掉它，供 host-smoke 验证「可选依赖没装上」的安装形状。
//   用法：node scripts/publish-shape.cjs <in package.json> <out package.json> [--without-optional]
const fs = require('fs')
const [input, output, flag] = process.argv.slice(2)
if (!input || !output || (flag !== undefined && flag !== '--without-optional')) {
  console.error('usage: publish-shape.cjs <in package.json> <out package.json> [--without-optional]')
  process.exit(2)
}
const p = JSON.parse(fs.readFileSync(input, 'utf8'))
const out = { ...p, main: 'lib/index.js', exports: p.publishConfig.exports, files: ['lib', 'locale', 'assets/icon.svg', 'cordis.patch.yml', 'README.md', 'THIRD_PARTY_NOTICES.md'] }
out.scripts = Object.fromEntries(Object.entries(p.scripts ?? {}).filter(([k]) => !k.includes('e2e')))
if (flag === '--without-optional') delete out.optionalDependencies
fs.writeFileSync(output, JSON.stringify(out, null, 2) + '\n')
