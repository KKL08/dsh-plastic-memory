# dsh-plastic-memory

dsh 的跨 session 结构化记忆插件：把对话里值得长期记住的信息（用户偏好、项目状态、事实经验）存下来，按 session 冻结成 snapshot 注入上下文，并配一层治理机制防止记忆腐烂。

## 安装

```bash
dsh plugin --profile <name> add ./dsh-plastic-memory
```

`<name>` 换成目标 profile 名（如 `web`）。安装后插件的 bundle 声明（见 `cordis.patch.yml`）会写入该 profile 自己的 cordis.patch.yml，随 profile 一起启动。

## 配置项

在 profile 的 cordis.patch.yml 里，找到 `id: plastic-memory` 那一行，在 `config` 下调整：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `writeMode` | `'proactive'` | 写入模式。`proactive` 是模型在对话中直接调 `memory_save`；`reflective`（P1）是空闲后由小模型异步提取，P0 只支持 `proactive`，其余取值按 `auto` 兼容处理 |
| `reflectModel` | `null` | `reflective` 模式下用的模型名，P0 未启用 |
| `reflectIdleMinutes` | `30` | `reflective` 模式下的空闲触发阈值（分钟），P0 未启用 |
| `approval` | `'auto'` | 写入审批策略。`auto` 免审批直接写，`always`/`by-type`（P1）分别是逐条审批、按类型审批，P0 只支持 `auto` |
| `approvalTypes` | `[]` | `approval: by-type` 时需要审批的类型列表，P0 未启用 |
| `snapshotTokenBudget` | `4000` | frozen snapshot 注入上下文时的 token 预算上限 |
| `template` | `'coding'` | 场景模板，决定内置五类之外追加哪些类型。`coding` 追加 `procedure`（可复用流程），`office` 追加 `decision`/`commitment`/`person`，`custom` 不追加，只用五类内置 + `customTypes` |
| `customTypes` | `{}` | 用户自定义类型，键是类型名，值是 `{ label, description, recall, decayDays, governancePriority }`；不能与内置五类重名，重名插件加载即报错 |
| `governance.enabled` | `true` | 是否启用治理层（陈旧度标注、健康检查等） |
| `governance.onWrite` | `true` | 是否在每次写入时触发治理检查（如重复检测） |

## 内置五类记忆

不区分模板，任何配置下都可用：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| `profile` | 用户画像 | 用户的身份、角色、能力和知识水平。例：「用户是数据工程师，Go 熟练，React 刚上手」 |
| `preference` | 行为偏好 | 用户纠正过的做法、确认过的习惯。例：「测试里不要 mock 数据库」 |
| `knowledge` | 事实与经验 | 不随项目结束而失效的客观事实、规则、工具行为。例：「报销截止每月 25 日」 |
| `project` | 项目信息 | 绑定项目生命周期的状态、决策、进展。例：「merge freeze 到 3 月 5 日」 |
| `reference` | 参考引用 | 外部资源的位置指针，回答「去哪找」。例：「pipeline bugs 在 Linear 的 INGEST 项目」 |

`template: coding`（默认）额外追加 `procedure`（可复用流程），`template: office` 额外追加 `decision`/`commitment`/`person`。

## 工具

**P0 已实现：**

- `memory_save` —— 保存或更新一条记忆（`action: create|update`）。写入前过格式校验、结构去重和审批决策；怀疑重复时返回 duplicate-suspected，需要模型改用 `update` 或带 `force: true` 重发。
- `memory_search` —— 按关键词检索记忆（匹配内容/摘要/标签），可按类型和 scope（global/workspace/all-visible）过滤。
- `memory_forget` —— 软删除一条记忆（标记已删除，不再注入和检索），需要给出遗忘原因。

**P1 规划中（尚未实现）：**

- `memory_confirm` —— 确认记忆仍然有效，刷新陈旧度时间戳。
- `memory_scan` —— 触发一次深度治理扫描。
- `memory_health` —— 返回记忆库的健康评分和问题摘要。

## 范围说明

当前是 P0：五类内置类型、三个核心工具、写入候选管线、frozen snapshot 注入、proactive 写入模式、陈旧度标注。P1 计划补齐 reflective 写入模式、治理层三个工具、健康评分、场景模板/自定义类型的进一步打磨，以及 office 模板的 sensitivity gate；P2 展望包括 companion 模板、可视化记忆地图、技能结晶等。详见 `docs/prd-plastic-memory.md` 第 11 节。
