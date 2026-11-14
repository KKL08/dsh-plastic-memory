# 配置参考

[返回首页](../README.md)

在 Profile 对应的 `cordis.patch.yml` 中调整 `plastic-memory` 配置：


| 配置项                              | 默认值               | 说明                                                           |
| -------------------------------- | ----------------- | ------------------------------------------------------------ |
| `writeMode`                      | `'proactive'`     | 写入模式（目前唯一值，后续会扩展更多模式）                                        |
| `snapshotTokenBudget`            | `4000`            | 每次对话自动带入记忆的 token 上限，对话中检索到的不计入                  |
| `snapshotOverflow`               | `'relax'`         | 超出上限时：`relax` 全部带入并按 25% 一档提醒 / `strict` 严格按上限截断并提示漏掉几条          |
| `evidenceLookup`                 | `'strict'`        | 什么时候溯源记忆出处：`off`（仅你要求时） / `strict`（遇到矛盾或高风险时） / `active`（需要更多背景时也会回查）         |
| `template`                       | `'custom'`        | 当前场景：`custom`（通用）/ `coding` / `office` / 自己建的场景 id；指向不存在的场景时按通用运行      |
| `customTypes`                    | `{}`              | 自定义记忆类型定义字典，进入类型池                                       |
| `scenes`                         | 编码、办公两项          | 场景定义：`label` 场景名、`types` 包含的类型（1 到 8 类）。通用场景固定，不写在这里 |
| `removedPresetTypes`             | `[]`              | 删掉的预设类型（`procedure`、`decision`）：不再新增，已有记忆照常读取          |
| `governance.enabled`             | `true`            | 是否启用主动治理层（体检、健康分、冲突裁决、提权、子 agent 写入等），只能在配置文件里改 |
| `governance.health.sensitivity`  | `'normal'`        | 健康警报灵敏度：`conservative` / `normal` / `proactive`              |
| `governance.globalPromoteTarget` | `'plugin-global'` | 提权目标：`plugin-global`（插件全局域）或 `agents-md`（`${DSH_HOME:-~/.dsh}/AGENTS.md`） |
| `subagent.maxSavesPerSession`    | `10`              | 每个子 agent 会话最多新建几条记忆（只能在配置文件里改），改了下一次保存生效 |
| `accent`                         | `'ella'`          | 界面主题色：`ella`（艾拉主题色）/ `blue-whale`（大肥鱼主题色，跟随 DeepSeek Harness 品牌蓝） |
| `memoryRoot`                     | `''`              | 存储根路径，缺省为 `${DSH_HOME:-~/.dsh}/memories`；改了要重启 DeepSeek Harness 才生效                     |
| `search.userDictionaryPath`      | 不设                | 用户词典路径（只能在配置文件里改）：追加在内置词典之上，改了下一次搜索生效。要填绝对路径；每行「词 词频 词性」，词频必填，不带词频的词条不生效，例如 `插件记忆 10 n`。没装 `@node-rs/jieba` 时不生效 |

除 `memoryRoot` 外，改动都不用重启，已开着的对话下一步就按新设置来。

自动体检的频率在记忆页按范围设置，存在 `<memoryRoot>/.state/` 里，不写进 `cordis.patch.yml`。
