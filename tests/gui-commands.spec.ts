// 各命令族的用例拆在 gui-commands-*.test.ts，由这个入口加载：普通和无 SQLite 两个测试项目照旧都跑全部命令族。
import './gui-commands-core.test.ts'
import './gui-commands-delete.test.ts'
import './gui-commands-promote.test.ts'
import './gui-commands-checkup.test.ts'
import './gui-commands-edit.test.ts'
import './gui-commands-plan.test.ts'
import './gui-commands-suggestions.test.ts'
import './gui-commands-proposals.test.ts'
