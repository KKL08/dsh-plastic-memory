# 记忆类型与场景

[返回首页](../README.md)

## 五类基础记忆

系统内置 5 类基础记忆类型。通用场景固定包含这 5 类，其他场景默认带上，可以按需去掉：


| 类型 (`Type`)  | 说明                   |
| ------------ | -------------------- |
| `profile`    | 用户本人的身份、背景、所在地、生活习惯、兴趣、长期目标与能力画像 |
| `preference` | 用户提出、纠正或确认过的做事要求与习惯 |
| `knowledge`  | 经过确认、以后还会用到的事实、规则与经验 |
| `project`    | 进行中的项目或个人事项的当前状态与安排 |
| `reference`  | 与项目相关的外部资料在哪里：文件路径、网页链接、外部文档或系统入口 |




## 场景

场景决定模型能新增哪几类记忆，从类型池里挑选。类型池包括基础 5 类、两个预设类型（`procedure` 可复用的标准操作流程、`decision` 决定与承诺：谁定了什么、谁答应了谁什么），以及你自定义的类型。

- 通用（`custom`，默认）：固定基础 5 类，不能编辑、删除。
- 编码（`coding`）：基础 5 类 + `procedure`。
- 办公（`office`）：基础 5 类 + `decision`。
- 自己建的场景：在设置页新建，默认勾上基础 5 类，可以去掉。

编码、办公可以增减类型，也可以删除。每个场景 1 到 8 类，通用以外最多 5 个场景（编码、办公也算在内）。同一时间只有一个当前场景，整个 profile 共用。切换场景只影响新增：类型池里所有类型的已有记忆照常带入、能搜到。

基础 5 类固定，设置页里只能查看定义。两个预设类型可以改定义（英文名不变），也可以删除。删除时可以选保留已有记忆或移到最近删除，之后能在设置页恢复（恢复后要在场景里重新勾选）。改过的预设存成 `customTypes` 里的同名一项，删掉的列在 `removedPresetTypes` 里。

旧版办公模板的 `commitment`（承诺）并进了 `decision`，`person`（人物）已移除。这两类已有的记忆照常读取，但不能再新增。



## 召回注入模式 (`recall`)

控制不同记忆类型在上下文中的呈现形式：


| 模式        | 注入行为                           | 适用场景        |
| --------- | ------------------------------ | ----------- |
| `core`    | **全文**：正文随开头的记忆快照带入对话（`strict` 下最多占上限的一半） | 高频核心偏好与人设画像 |
| `search`  | **摘要**：名称和摘要以一行索引进入概览，模型按需调取 | 详细流程规范与业务知识 |
| `passive` | **简单索引**：索引里只列名称和标签，最大化节约 Token | 低频调用的参考信息   |

内置类型的默认模式：`profile`、`preference` 是 `core`；`knowledge`、`project`、`reference`、`procedure`、`decision` 是 `search`；`passive` 留给自定义类型选用。




## 自定义类型定义

在设置页「记忆类型」或场景弹层里新建，或在配置项 `customTypes` 中声明（名称不能与内置 5 类冲突）。自定义类型进入类型池，勾进某个场景后才用来新增记忆。在设置页里改英文名时，已存过的记忆可以跟着改名或移到最近删除；删除类型时可以保留这些记忆，或移到最近删除：

```yaml
customTypes:
  ritual:
    label: 团队仪式
    description: 定期执行的团队流程与规范
    whenToSave: 用户提到固定周期执行的流程或仪式时
    howToUse: 安排相关工作时按记下的周期和规范来
    recall: search
    governancePriority: low
    decayDays: 90
scenes:
  coding:
    label: 编码
    types: [profile, preference, knowledge, project, reference, procedure]
  office:
    label: 办公
    types: [profile, preference, knowledge, project, reference, decision]
  scene-mh2k9x:
    label: 团队协作
    types: [profile, preference, knowledge, project, reference, decision, ritual]
template: scene-mh2k9x
```

`description`、`whenToSave` 写给模型看：保存记忆时，模型按它们判断这条该归哪一类、怎么写。`howToUse` 选填，写这类记忆带入对话后怎么用，和记忆一起交给模型。`governancePriority` 决定上限吃紧时哪类先被截掉。`decayDays` 是衰退天数：超过这个天数没确认的记忆只标为可能过时，不会失效；`null` 表示不衰退。

手写 `scenes` 时要列全所有场景，漏掉的编码、办公会消失。建议优先在设置页里改。

## 子 agent 记忆规则

DeepSeek Harness 派出的子 agent（包括子 agent 再往下派的）也能用 `memory_save` 存记忆。这些记忆先是待确认：只落当前项目，不带入主会话，检索时排在其他记忆之后，索引行和检索结果里标「（子 agent 写入，未确认）」。子 agent 存完会在回复里报出来，由主会话决定去留：

- 接受：`memory_confirm` 的 `accept-subagent` 动作，之后和本项目其他记忆一样带入、检索；
- 改写：`memory_save update`，改完同样算接受；
- 丢弃：`memory_forget`。

主会话不处理的，一直待确认。你不用逐条过目：主会话觉得某条该进全局时，它照常出现在记忆页「处理」视图的提升候选里；记忆卡上也会显示「子 agent 写入 · 第 N 层 · 待确认」（接受后是「主会话已接受」或「用户已改」），在记忆页直接改或提升一条待确认记忆也算接受。

子 agent 只能写 `knowledge`、`project` 两类（还要在当前场景里），依据（`sourceMode`）只能是观察或推断，不能用 `supersedes`、`force`，只能改自己这个会话存下、还没被接受的。每个子 agent 会话最多新建 `subagent.maxSavesPerSession` 条（默认 10）。子 agent 写入跟着治理开关走：`governance.enabled` 为 `false` 时，子 agent 会话照旧只读。

**已知限制**：这些规则只约束工具调用。子 agent 带文件工具、直接改记忆目录里的文件时，不受这些规则约束；用 DeepSeek Harness SDK 启动的子进程如果也装了本插件，会被当成主会话。
