import type { MemoryRecord } from '../../src/record-schema.ts'

/**
 * memory_search 评估集：合成语料 + 查询 + 预期，回归测试（tests/search-eval.spec.ts）与开发脚本
 * （scripts/eval-search.ts）共用这一份。
 *
 * 语料贴近真实记忆形状：name / summary / tags / content 齐全，正文一百到五百字，中文为主、夹标识符与英文。
 * 一半是记忆插件自身的设计与流程，一半是通用开发项目的经验；有意放进共享高频词的干扰项
 * （快照、模板、门禁、预算、副本、评审、侧栏、置信度……出现在主题不同的记录里）。
 * 全部虚构：不含真实路径、主机名、人名。
 */

interface EvalMemory {
  id: string
  type: string
  name: string
  summary: string
  tags: string[]
  content: string
  confidence?: number
  lastConfirmedAt?: number
}

const MEMORIES: EvalMemory[] = [
  // ---- 记忆插件：设计与流程 ----
  {
    id: 'mem_k7q2a1', type: 'knowledge', name: '快照在会话首轮冻结',
    summary: '注入快照只在会话第一轮组装一次，之后同一会话复用冻结结果',
    tags: ['snapshot', '性能'],
    content: '注入快照在会话第一轮组装：按范围预读当前项目与 global 两层，挑出 core 类记忆拼成索引行，然后冻结。'
      + '冻结后同一会话的后续轮次直接复用，不再重读磁盘，所以会话中途新存的记忆要到下一个会话才出现在注入里。'
      + '实测 1000 条记忆时冻结耗时中位数约 3 ms，主要花在组装索引行；预读本身的耗时算在 readScope 头上。'
      + '冻结那一刻顺带给入选记忆计一次召回，后续轮次不重复计。',
  },
  {
    id: 'mem_r4t8b2', type: 'knowledge', name: '跨工作区读取的门禁',
    summary: '读其他项目的记忆要过门禁：用户确认后只读，不能写',
    tags: ['cross-workspace', '权限'],
    content: '模型想读另一个项目的记忆时，执行器先检查门禁：当前会话的工作目录与目标项目不同，就要求用户在确认框里点同意。'
      + '同意只对这一次读取有效，不会记住；读到的结果标注来源项目，并且只读，memory_save 不能写进别的项目。'
      + '门禁的目的是防止一个项目的偏好悄悄渗进另一个项目。全局层不受门禁限制，任何会话都能读写 global。',
  },
  {
    id: 'mem_p9w3c4', type: 'knowledge', name: '密钥类记忆直接硬删除',
    summary: '检测到含密钥的记忆不走软删，直接从磁盘删掉',
    tags: ['secret', '删除'],
    content: '普通记忆删除是软删：status 改成 deleted、文件移进 .archive/，过了保留窗口才由清扫任务真正删掉。'
      + '含密钥的记忆例外：扫描发现 token、私钥、连接串之类的明文，直接硬删除文件，不进 .archive/，也不留在任何回收区，'
      + '避免密钥在归档里多躺几十天。硬删除之后在待处理列表里留一条说明，告诉用户删了哪条、为什么删，但不复述密钥内容。',
  },
  {
    id: 'mem_h2m6d8', type: 'knowledge', name: '子代理只读',
    summary: '子 agent 能搜索与读取记忆，但不能保存或修改',
    tags: ['subagent', '权限'],
    content: '子 agent 和主会话在同一个宿主进程里跑，共享同一份记忆存储。为了避免并行的子 agent 各自写出互相冲突的记忆，'
      + '子 agent 只开放 memory_search 与 memory_source，调用 memory_save 会被拒绝并提示「子代理只读，请把要记的内容交回主会话」。'
      + '判断依据是会话元数据里的父会话字段，而不是工具参数，模型改不了。',
  },
  {
    id: 'mem_c5n1e3', type: 'knowledge', name: '手编文件后的出处标注',
    summary: '记忆文件被手工改过时，出处可能对不上，读取时加标注',
    tags: ['hand-edit', '出处'],
    content: '每条记忆的 frontmatter 存一份正文摘要 digest。读取时重算，发现和存的不一致，就认定文件被手工编辑过，记录打上 handEdited。'
      + '这时出处里的会话与事件区间可能已经对不上正文：用户改了措辞，原始会话里并没有这句话。'
      + 'memory_source 遇到 handEdited 的记录会先说明「内容被手动修改过，出处可能对不上」，再给出原会话片段。'
      + '下一次 memory_save update 重写该条时清除标记。',
  },
  {
    id: 'mem_x8v4f6', type: 'knowledge', name: '同 id 多副本的取舍规则',
    summary: '同一个 id 出现在多个文件时，按固定顺序只留一份',
    tags: ['duplicate', 'storage'],
    content: '两个进程并发写、或者用户手工复制文件，都可能让同一个 id 出现在多个文件里。读取时 resolveDuplicates 统一取舍：'
      + '先看层，当前工作区的副本优先于 global；同层再比 updatedAt，新的留下；还分不出就按文件名排序取第一个。'
      + '落选的副本不删除，体检时列为问题，让用户决定合并还是删掉。搜索、快照、体检都走这一条取舍，结果一致。',
  },
  {
    id: 'mem_z3b7g9', type: 'project', name: '注入超出上限的处理',
    summary: '注入内容超过预算时默认自动放宽并分档提醒，严格模式到 95% 就提醒',
    tags: ['budget', 'snapshot'],
    content: '注入有一个字符预算上限。默认策略是自动放宽：超出时不截断，照常注入全部 core 记忆，'
      + '但每超出 25% 记一档，在待处理里提醒一次，提醒带一个快捷操作直接改上限。'
      + '严格模式下用到 95% 就提醒，超出部分按优先级截掉。提醒只进待处理列表，不打断当前对话。体检也会把长期超出列为问题。',
  },
  {
    id: 'mem_t6y2h4', type: 'project', name: '切换模板后立即生效',
    summary: '记忆模板改了不用重启，下一次读取就按新模板解释类型',
    tags: ['template', 'config'],
    content: '模板决定有哪些记忆类型以及各自的召回方式。改模板后不需要重启宿主，也不按会话记录旧模板：下一次读取就用新模板。'
      + '旧模板里有、新模板里没有的类型，读的时候照样认得，按兜底策略处理；写的时候只允许新模板的类型。'
      + '这样切来切去不会丢记忆，也不会出现一半会话用旧规则、一半用新规则的情况。',
  },
  {
    id: 'mem_j1u5k8', type: 'project', name: '自动体检的三个档位',
    summary: '自动体检分关闭、轻量、完整三档，默认轻量',
    tags: ['health', 'config'],
    content: '自动体检有三档：关闭、轻量、完整。轻量只跑规则层，检查过期、重复 id、超出上限这类不需要模型的问题；'
      + '完整档再加语义扫描，让模型找相互矛盾或已经过时的记忆，会消耗 token。默认轻量，在设置页切换。'
      + '体检关闭时，设置页里依赖体检的三项开关一起置灰，避免用户以为它们还在工作。',
  },
  {
    id: 'mem_s4i9l2', type: 'reference', name: '宿主插件页的配置表单',
    summary: '插件设置页用宿主的 configForms 声明字段，宿主负责渲染和写回',
    tags: ['gui', 'host'],
    content: '插件不自己画设置页，而是在注册时提供 configForms：每个字段给出键名、类型、默认值和说明文字，宿主按统一样式渲染，'
      + '用户保存后宿主把值写回插件配置并触发热更新。字段说明超过四条时宿主不再逐条显示，需要精简。'
      + '自定义校验只能在插件读取配置时做，表单本身只支持类型校验。',
  },
  {
    id: 'mem_f7o3m5', type: 'procedure', name: '发版步骤',
    summary: '发版前全绿、改版本号、推 tag、npm 发布、验证安装',
    tags: ['release', 'npm'],
    content: '发版顺序：先在分支上跑 typecheck、单测、host:smoke、host:contract 全绿；改 package.json 的 version、两份 README 的版本号和 CHANGELOG，'
      + '放进同一条 release 提交；合并后在 merge 提交上打 tag 推上去，Release 页由 workflow 自动生成。'
      + '然后 npm publish，beta 版带 --tag beta，发完顺手把 latest dist-tag 指过去。npm 有服务端安检暂存，发布后约十分钟才能装到，'
      + '这期间的 404 不是失败。最后在隔离目录装一遍确认能加载。',
  },
  {
    id: 'mem_g2p8n1', type: 'project', name: '宿主版本的钉法',
    summary: '开发依赖钉最新宿主，peer 只设下界，下界不跟着钉版抬',
    tags: ['host', 'dependencies'],
    content: '四个宿主包在 peerDependencies 里只声明下界，不设上界；devDependencies 钉当前最新的宿主版本，CI 的 check 档跑在它上面。'
      + '另有一个 host-floor 档把开发依赖改写成 peer 下界再跑同一套检查。升钉版是例行操作，下界不跟着抬；'
      + '只有插件要用下界宿主没有的接口，或者宿主出现破坏性变更时才抬，并在 CHANGELOG 写明原因。',
  },
  {
    id: 'mem_d9a4o7', type: 'knowledge', name: '挑战式评审的发现',
    summary: '独立评审专门找不该上线的理由，这轮找出三处实质问题',
    tags: ['review'],
    content: '这次请独立评审只找「不该上线的理由」，要求每条带文件行号和置信度。找出三处实质问题：'
      + '预筛开关会改变 df 的统计口径；同 id 取舍在搜索与快照两条路上顺序不一致；'
      + '用户词典路径是相对路径时按宿主工作目录解析，不可靠。前两条当场修（取舍规则统一记在 mem_x8v4f6），第三条改成要求绝对路径并在文档写明。',
  },
  {
    id: 'mem_w5s1p3', type: 'project', name: '一条记忆一个文件',
    summary: '记忆以 markdown 文件存放，构造存储不做任何 IO，读取按范围',
    tags: ['storage', 'design'],
    content: '每条记忆是一个 markdown 文件：frontmatter 放元数据，正文放内容，用户可以直接用编辑器打开、用 grep 搜。'
      + '构造存储对象时零 IO，不扫描目录也不建索引；真正的读取按范围进行，一次读当前项目和 global 两个目录。'
      + '召回次数这类频繁变化的统计放在旁路的 sidecar 里，不改记忆文件本身，避免每次搜索都改写文件、污染用户的版本管理。',
  },
  {
    id: 'mem_e8d6q2', type: 'knowledge', name: '两个进程同时写同一目录',
    summary: '多进程写入靠文件名占位与写锁，脱敏在锁内串行做',
    tags: ['concurrency', 'secret'],
    content: '同一台机器上可能有两个宿主进程同时写记忆目录。写入时先用独占创建占住文件名，同名冲突就换一个后缀，'
      + '所以两条同名异 id 的记录都能存活。密钥脱敏要读原文、改写、再落盘，放在写锁内串行化，'
      + '否则两个进程交错执行会把脱敏前的原文写回去。写锁按目录粒度，锁文件超时三十秒视为陈旧可抢占。',
  },
  {
    id: 'mem_v3f9r6', type: 'project', name: '冲突显示在记忆行上',
    summary: 'GUI 里的冲突提示挂在对应记忆行，不单独开冲突页',
    tags: ['gui', 'conflict'],
    content: '记忆管理界面的侧栏列出全部记忆。两条记忆相互矛盾时，不另开冲突页，而是在侧栏对应的两行各挂一个琥珀色圆点，'
      + '点开看到对方是哪条、矛盾在哪，可以就地选择保留哪条或合并。琥珀色只用在这个圆点上，别处不用，免得用户分不清是警告还是装饰。',
  },
  {
    id: 'mem_n6g2s9', type: 'project', name: '待处理列表的提醒方式',
    summary: '需要用户决定的事进待处理列表，不在对话里打断',
    tags: ['pending', 'gui'],
    content: '体检发现的问题、超出上限的提醒、硬删除的说明，都进待处理列表。待处理条目带一个快捷操作，例如「改上限」「合并」「忽略」。'
      + '对话里不弹窗也不插话，只在会话开始时用一句话提示「有 3 条待处理」。用户处理过的条目保留三十天的记录，之后清掉。',
  },
  {
    id: 'mem_b1h7t4', type: 'knowledge', name: '记忆新鲜度',
    summary: '每种类型有衰减天数，超过就在结果里标注可能过时',
    tags: ['freshness', 'decay'],
    content: '每个记忆类型有 decayDays：决定类 30 天，流程类 90 天，画像类不衰减。距离上次确认超过这个天数，'
      + '搜索结果和注入索引行就带一个「可能过时」的标注，提醒模型先核实。会话里再次确认后 lastConfirmedAt 刷新，标注消失。'
      + '新鲜度只影响标注，不影响排序，也不会自动删除。',
  },
  {
    id: 'mem_y4j3u8', type: 'knowledge', name: '搜索结果的次级排序',
    summary: '分数相同时按置信度，再按最近确认时间',
    tags: ['search', 'ranking'],
    content: 'memory_search 先分档再按相关性分数排序。分数完全相同的记录，按 confidence 从高到低，再按 lastConfirmedAt 从新到旧。'
      + '置信度来自出处：用户明确说的 0.9，从行为推断的 0.8，模型自己推断的 0.5。'
      + '零关键词查询不打分，直接按这两个次级键排，相当于列出最可信、最新确认的记忆。低置信度记忆的用法见 mem_o4m7s1。',
  },
  {
    id: 'mem_q7k8v1', type: 'procedure', name: '把项目记忆提升到全局',
    summary: '模型判断该全局但无权直写时打候选标记，体检时让用户确认提升',
    tags: ['promote', 'global'],
    content: '模型觉得某条记忆对所有项目都适用，但没有直接写 global 的权限，就写进当前项目并打上 globalCandidate 标记。'
      + '体检时这些候选汇总进待处理，用户确认后执行提升：在 global 写一份新记录，原记录标 superseded 并指向新记录。'
      + '用户拒绝则清掉标记，以后同一条不再提名。',
  },
  {
    id: 'mem_m2l5w7', type: 'decision', name: '搜索命中返回全文',
    summary: 'memory_search 每条命中返回完整正文，不截片段，并附文件路径',
    tags: ['search', 'design'],
    content: '讨论过搜索结果只返回片段还是全文。片段省 token，但模型经常要再调一次读取才能用，总成本反而更高；'
      + '记忆正文本来就限制在几百字以内。最后定为返回全文，并在头行末尾附上文件的绝对路径（名称含密钥的不附），模型需要上下文时可以直接读文件。片段方案留作以后正文变长时再议。',
  },
  {
    id: 'mem_u9z6x3', type: 'knowledge', name: '工作区目录名的算法',
    summary: '项目记忆目录名 = 项目名 slug + 路径 hash',
    tags: ['storage', 'workspace'],
    content: '每个项目的记忆放在一个以项目命名的子目录里，目录名由两段组成：项目文件夹名做 slug（小写、非字母数字换成连字符、截断到 40 字符），'
      + '后面接完整路径的短 hash。slug 只为了让人看得懂，不承担可逆性；真实路径写在目录里的 .workspace 标记文件中。'
      + '项目改名或搬家后 hash 变了，会得到一个新目录，旧目录由体检提示迁移。',
  },
  {
    id: 'mem_i3x1y5', type: 'reference', name: '查记忆的原始出处',
    summary: 'memory_source 按记忆的出处下钻到原始会话事件',
    tags: ['memory_source', 'tool'],
    content: 'memory_source 接收一个记忆 id，读出它 source 里的 sessionId 与 eventRange，回到原始会话取出那几轮对话原文。'
      + '会话已被清理时返回「出处会话不可用」。手建的文件没有 source 字段，返回「无出处」。'
      + '这个工具是只读的，子 agent 也能用，适合在模型怀疑记忆内容时核对用户当初的原话。',
  },
  {
    id: 'mem_o6c4z2', type: 'reference', name: '按范围读取接口',
    summary: 'readScope 一次读一个范围，返回带位置的记录和列出文件数',
    tags: ['storage', 'api'],
    content: 'readScope(scope, options) 是存储层唯一的批量读取入口：scope 可以是 global、某个工作区，或当前会话可见的全部。'
      + 'options 支持 types 过滤和预筛词；带预筛词时先看原文是否包含任一词，不含就跳过解析。'
      + '返回值里每条记录带它所在的文件路径，另有 listedCount 表示范围内顶层列出的记忆文件数，搜索用它作 BM25 的 N。',
  },
  {
    id: 'mem_l8e2b6', type: 'knowledge', name: '搜索的三档结果',
    summary: '全部关键词命中、部分命中、只有子串命中，三档拼成一张表',
    tags: ['search'],
    content: 'memory_search 把候选分三档：查询的每个词都命中的排最前，命中一部分的其次，一个词都没命中但关键词以子串出现的放最后。'
      + '档内按相关性分数排序，档与档之间不交叉，最后统一按 limit 截断。返回列表里没有第一档时附一句说明，'
      + '只剩子串档时换另一句说明，提示模型这些结果可能不相关。',
  },
  {
    id: 'mem_a5r7c9', type: 'project', name: '中文分词的可选依赖',
    summary: '中文检索默认用词典分词，依赖装不上时退回二字切分',
    tags: ['search', 'jieba'],
    content: '中文查询用词典分词器切词，它作为可选依赖安装，带十几个平台的预编译二进制。装不上或者平台缺二进制时，'
      + '搜索退回二字滑窗切分，结果仍然可用，只是长句的精度差一些。每种失败每个进程只告警一次。'
      + '主词典常驻内存三四十兆，首次中文搜索时才加载，纯英文查询不加载。',
  },
  {
    id: 'mem_c2w9d1', type: 'knowledge', name: '用户词典的写法',
    summary: 'userDictionaryPath 指向词典文件，每行「词 词频 词性」，追加到主词典',
    tags: ['search', 'config'],
    content: '设置项 search.userDictionaryPath 填一个绝对路径，文件每行写「词 词频 词性」，例如「待处理 50000 n」。'
      + '这些词追加到主词典之上，不替换主词典。词频太低的词会输给拆开的切法，不带词频的行不生效。'
      + '改了路径下一次搜索就重新加载；文件读不了或格式不对时只用主词典，并按路径告警一次。',
  },
  {
    id: 'mem_r1f3e5', type: 'knowledge', name: '召回统计放旁路文件',
    summary: 'recallCount 与 lastRecalledAt 存在 sidecar，不写回记忆文件',
    tags: ['storage', 'sidecar'],
    content: '每次搜索命中或注入入选都会增加召回次数。如果写回记忆文件，用户的版本管理里会出现大量无意义的改动，'
      + '所以召回统计单独放在旁路的 sidecar 键值文件里，读取时再合并到记录上。两个进程同时更新时按条目合并，不整体覆盖。sidecar 损坏时召回统计归零重新累计，不影响记忆本身。',
  },
  {
    id: 'mem_s9h4f2', type: 'knowledge', name: '过期记忆的处理',
    summary: 'validTo 已过的记忆不进搜索和注入，但体检仍能看到',
    tags: ['validity'],
    content: '记忆可以带 validTo，表示到某个时间点失效，例如临时的发布冻结期。过了 validTo 的记录不进搜索结果、不进注入，'
      + '但体检扫描仍然能看到它们，并提示用户删除或延长。validFrom 还没到的记录同理暂不生效。'
      + '这一点和新鲜度不同：新鲜度只加标注，validTo 直接让记录不可见。',
  },
  {
    id: 'mem_t4k6g8', type: 'project', name: '会话结束时的保存提示',
    summary: '会话里出现值得记的内容时，结尾提示一次是否保存',
    tags: ['save', 'ux'],
    content: '模型在会话中发现用户纠正了某个做法、或者定下了一个决定，不立刻保存，而是在合适的停顿处问一句是否记下来。'
      + '同一会话里同类提示最多一次，用户说不用就不再问。用户明确说「记住」时直接保存，置信度记 0.9。用户在设置里关掉保存提示后，只在明确要求时保存。',
  },
  {
    id: 'mem_b7m3h1', type: 'knowledge', name: '重复检测走语义层',
    summary: '新记忆与旧记忆是否重复，靠模型判断，不靠字面相似度',
    tags: ['duplicate', 'semantic'],
    content: '保存前要判断新内容是否与已有记忆重复。字面相似度只能做初筛：中文 n-gram 重叠高的两句话可能意思相反，'
      + '重叠低的也可能是同义改写。所以字面相似度过阈值的候选交给模型做语义判定，模型认为重复时提示更新旧记录而不是新建。',
  },

  // ---- 通用开发项目：经验、偏好、流程 ----
  {
    id: 'mem_p3n8j4', type: 'preference', name: '包管理用 pnpm',
    summary: '这个项目一律用 pnpm，CI 里用 frozen-lockfile',
    tags: ['pnpm', 'tooling'],
    content: '项目统一用 pnpm 管依赖，不要用 npm 或 yarn 装包，否则会生成多余的 lockfile。'
      + 'CI 里执行 pnpm install --frozen-lockfile，lockfile 和 package.json 对不上就直接失败，提醒提交者先在本地更新 lockfile。'
      + '新增依赖前先说明理由，业界默认的工具链（测试、格式化）直接加。',
  },
  {
    id: 'mem_d6x2k7', type: 'procedure', name: '预发环境上线',
    summary: '先上预发再全量，失败就回滚',
    tags: ['release', 'ops'],
    content: '上线分两步：先跑 pnpm run release:staging 把 deployment 推到预发环境，观察十分钟错误率和延迟；'
      + '没问题再执行全量 deployment。全量后保持半小时值守。任何一步健康检查失败，立刻执行回滚脚本退回上一个版本，'
      + '再在频道里说明原因。周五下午不做全量上线。',
  },
  {
    id: 'mem_h9c1l3', type: 'knowledge', name: '回滚脚本的坑',
    summary: '回滚只退代码不退数据库，迁移要单独处理',
    tags: ['rollback', 'ops'],
    content: '回滚脚本 rollback.sh 只把服务切回上一个镜像，不会撤销数据库变更。如果这次上线带了不兼容的表结构变更，'
      + '光回滚代码会让旧代码读新表报错。所以表结构变更要分两次上线：先加字段并兼容旧代码，确认稳定后再删旧字段。'
      + '真要撤销迁移，手动执行对应的 down 脚本，先在预发演练。',
  },
  {
    id: 'mem_m4v7n2', type: 'knowledge', name: '数据库迁移文件约定',
    summary: '每个迁移只做一件事，已发布的迁移不再修改',
    tags: ['database', 'schema'],
    content: '数据库 migrations 目录下每个文件只做一件事：加一张表、加一个索引，或者改一个字段。文件名以时间戳开头，保证顺序。'
      + '已经在生产执行过的文件不许再修改，要改就新写一个；否则新旧环境的表结构会悄悄分叉。'
      + '每个文件都要写 up 和 down 两部分，down 在预发演练过才能合并。',
  },
  {
    id: 'mem_f1q5p8', type: 'preference', name: '提交信息格式',
    summary: '提交信息用 Conventional Commits，英文祈使句',
    tags: ['git', 'style'],
    content: '提交信息按 Conventional Commits 写：type(scope): summary，summary 用英文祈使句，五十字符以内，不加句号。'
      + 'body 写改了什么、为什么改，不写怎么改，七十二字符折行。小改动（改错字、修链接）可以简单写一句，不必套格式。'
      + '提交信息不出现内部代号，没有上下文的读者也要能看懂。',
  },
  {
    id: 'mem_w2g6r3', type: 'knowledge', name: 'CI 的依赖缓存',
    summary: 'GitHub Actions 缓存 pnpm store，按 lockfile 的 hash 做键',
    tags: ['ci', 'cache'],
    content: 'CI 里依赖安装原来每次两分钟。现在用 actions/cache 缓存 pnpm store 目录，缓存键取操作系统加 lockfile 的 hash，'
      + 'lockfile 不变时命中缓存，安装降到二十秒。注意缓存的是 store 而不是 node_modules，后者带平台相关的二进制，跨 runner 复用会出错。'
      + '缓存超过七天没用会被平台自动清掉。',
  },
  {
    id: 'mem_k5t9s4', type: 'knowledge', name: '配置的加载顺序',
    summary: '默认值 → 配置文件 → 环境变量，后者覆盖前者',
    tags: ['config'],
    content: '服务启动时 loadConfig 按三层合并配置：代码里的默认值，然后是项目根目录的配置文件，最后是环境变量，后面的覆盖前面的。'
      + '环境变量名统一加 APP_ 前缀，嵌套键用双下划线连接，例如 APP_DB__POOL_SIZE。'
      + '配置在启动时校验一次，缺必填项直接退出并打印缺了哪个键，不要带着默认值硬跑。',
  },
  {
    id: 'mem_j8b4t6', type: 'profile', name: '后端负责人的沟通习惯',
    summary: '先给结论再给细节，异步沟通优先',
    tags: ['team'],
    content: '后端负责人看消息习惯先看第一句，所以汇报时第一句就写结论和需要他做的决定，细节放后面。'
      + '他偏好异步沟通，能写在文档或评论里的不约会议；真要开会提前一天发议程。'
      + '涉及接口变更的事一定要抄送他，他负责对外接口的兼容性。他不看长篇截图，日志要贴文字。',
  },
  {
    id: 'mem_s3y7u1', type: 'profile', name: '设计同事的交付方式',
    summary: '设计稿在画布里交付，标注用令牌名不用色值',
    tags: ['team', 'design'],
    content: '设计同事在共享画布里交付设计稿，每个页面一个画板，组件状态（默认、悬停、禁用）都画全。'
      + '颜色和间距标注用设计令牌的名字，不写具体色值，前端照令牌实现即可。'
      + '有疑问直接在画布上评论，她每天下午集中回复一次。交付前她会在画布顶部写一段变更说明，先看那段再看画板。',
  },
  {
    id: 'mem_n7w1v5', type: 'project', name: '导出功能的交付承诺',
    summary: '答应产品周五前交付 CSV 导出的第一版',
    tags: ['commitment', 'export'],
    content: '和产品经理约定：周五下班前交付报表的 CSV 导出第一版，只支持当前筛选条件下的数据，上限一万行。'
      + 'Excel 格式和定时导出放到下一期。如果周四还没完成分页拉取的部分，要提前告诉产品，砍掉上限之外的需求。导出文件名带上筛选条件和导出时间，方便用户区分。',
  },
  {
    id: 'mem_x6r2w9', type: 'project', name: '日志级别约定',
    summary: '生产 info，本地 debug，敏感字段一律脱敏',
    tags: ['logging'],
    content: '生产环境日志级别 info，本地开发 debug。请求日志只记方法、路径、状态码和耗时，不记请求体。'
      + '涉及手机号、邮箱、token 的字段在日志中间件里统一脱敏，打印成前三位加星号。'
      + '排查线上问题需要更细的日志时，用动态开关临时调到 debug，半小时后自动恢复。',
  },
  {
    id: 'mem_q9u3x7', type: 'knowledge', name: 'HTTP 服务的超时设置',
    summary: 'requestTimeoutMs 设 30 秒，keepAlive 要比负载均衡长',
    tags: ['http', 'timeout'],
    content: 'HTTPServer 的 requestTimeoutMs 设成 30000，超过就返回 504，避免慢请求占住连接。'
      + 'keepAliveTimeoutMs 必须比前面负载均衡的空闲超时长几秒，否则负载均衡会复用一个服务端刚关掉的连接，偶发 502。'
      + '这两个值放在配置文件里，不要写死在代码中。',
  },
  {
    id: 'mem_y1z8a3', type: 'knowledge', name: '前端构建工具',
    summary: '前端用 esbuild 打包，配置集中在一个脚本里',
    tags: ['frontend', 'build'],
    content: '前端打包用 esbuild，所有 configuration 写在 build 脚本里，不用单独的配置文件。开发时开 watch 模式，'
      + '生产构建开 minify 和 sourcemap，sourcemap 不随包发布，只上传到错误监控。'
      + '构建产物按内容 hash 命名，方便 CDN 长缓存。',
  },
  {
    id: 'mem_a3c6b8', type: 'preference', name: '测试里不 mock 数据库',
    summary: '集成测试连真实的测试库，不 mock 数据库层',
    tags: ['testing', 'database'],
    content: '用户明确要求：测试里不要 mock 数据库。之前 mock 的测试全绿，上线后迁移脚本却在真实库上失败了。'
      + '现在集成测试连一个每次重建的测试库，测试之间用事务回滚隔离。只有网络、时钟、文件系统这类进程边界可以 mock，'
      + '自己写的模块之间不 mock。',
  },
  {
    id: 'mem_g8f4c2', type: 'knowledge', name: '不稳定测试的处理',
    summary: 'flaky 测试先隔离再修，不靠重试掩盖',
    tags: ['testing', 'ci'],
    content: '发现 flaky 测试，先把它挪进隔离列表，CI 主线不跑，同时开一个修复任务。不允许给测试加自动重试来掩盖问题。'
      + '常见原因是依赖真实时间、依赖测试执行顺序、或者共享了临时目录。测试里不用 sleep，等待条件用轮询加超时。',
  },
  {
    id: 'mem_c4h7d5', type: 'procedure', name: '本地开发环境启动',
    summary: '先起数据库容器，再跑迁移，最后起开发服务器',
    tags: ['dev', 'setup'],
    content: '本地启动顺序：docker compose up -d 起数据库和缓存，pnpm run db:migrate 跑迁移，再 pnpm dev 起开发服务器，默认端口 3000。'
      + '端口被占用时先查是不是上次的进程没退出。第一次启动要复制示例环境变量文件并填上本地数据库的连接串。',
  },
  {
    id: 'mem_v9k1e7', type: 'knowledge', name: '接口错误码约定',
    summary: '业务错误用四位错误码，HTTP 状态码只表达大类',
    tags: ['api', 'errors'],
    content: '对外接口出错时，HTTP 状态码只表达大类（400 参数错、401 未登录、403 无权限、500 服务端错），具体原因放在响应体的四位业务错误码里。'
      + '错误码按模块分段，订单 1xxx，用户 2xxx，支付 3xxx。新增错误码要同步更新文档里的错误码表，前端按码显示文案。',
  },
  {
    id: 'mem_e5j2f9', type: 'project', name: '缓存失效策略',
    summary: '更新数据后先写库再删缓存，不更新缓存',
    tags: ['cache'],
    content: '数据更新时先写数据库，成功后删除对应的缓存键，下一次读取再回源填充；不直接更新缓存，避免并发写把旧值写回去。'
      + '缓存都设过期时间，最长一小时，作为删除失败时的兜底。批量更新时按键前缀批量删除，删除失败只记日志不报错。热点键另有防击穿处理，不在这条策略里。',
  },
  {
    id: 'mem_l2n6g4', type: 'preference', name: '时间存储',
    summary: '时间一律存 UTC 时间戳',
    tags: ['time'],
    content: '数据库里时间字段统一存 UTC 毫秒时间戳，不存带时区的字符串。前端展示时按用户浏览器的时区转换，'
      + '报表按公司所在时区汇总，汇总口径在报表说明里写清楚。跨天的统计任务按 UTC 零点切分。接口传参和返回也用毫秒时间戳，不传格式化后的字符串，避免前后端各自解析出偏差。',
  },
  {
    id: 'mem_o8p3h6', type: 'knowledge', name: '界面文案的多语言',
    summary: '文案放 locale 文件，键名按页面分组',
    tags: ['i18n', 'frontend'],
    content: '界面上所有文案放在 locale 目录的 json 文件里，中文和英文各一份，键名按页面分组，例如 settings.save。'
      + '代码里不写死文案。新增键时两种语言要同时补上，缺失的键在开发模式下显示键名并在控制台告警。界面文案改动要过一遍长度：英文通常比中文长三成，按钮可能放不下。',
  },
  {
    id: 'mem_u1s5i3', type: 'preference', name: '代码注释的语言',
    summary: '注释用中文写，解释为什么而不是做什么',
    tags: ['style'],
    content: '代码注释用中文写，重点解释为什么这样做、有什么约束，而不是复述代码在做什么。'
      + '公开接口写文档注释，内部函数只在逻辑不直观时加注释。注释里不写任务编号和会话代号，这些对以后读代码的人没有意义。提交信息和对外文档仍按各自的语言约定。',
  },
  {
    id: 'mem_i6t9j2', type: 'knowledge', name: '依赖升级节奏',
    summary: '每月集中升一次依赖，大版本单独开分支',
    tags: ['dependencies'],
    content: '依赖每月第一周集中升级一次：小版本和补丁版本一起升，跑全量测试；大版本升级单独开分支，读完迁移指南再动手。'
      + '安全公告涉及的依赖不等月度窗口，当天处理。升级后在 CHANGELOG 里写一句影响用户的变化，没有就不写。锁文件的变更单独成一条提交，便于回退。',
  },
  {
    id: 'mem_z7a4k1', type: 'knowledge', name: '内存泄漏排查',
    summary: '用堆快照对比找泄漏对象',
    tags: ['performance', 'debug'],
    content: '服务内存缓慢上涨时，先在压测环境复现，间隔十分钟拍两次堆快照，用对比视图看哪类对象只增不减。'
      + '上次的泄漏是事件监听器重复注册：每次请求都往全局 emitter 上挂监听，从不移除。'
      + '拍快照会让进程停顿几秒，生产环境不要直接拍。',
  },
  {
    id: 'mem_b4d8l7', type: 'knowledge', name: '数据库备份',
    summary: '每晚做一次数据库快照，保留三十天',
    tags: ['database', 'backup'],
    content: '生产数据库每晚两点做一次全量快照，保留三十天；每小时做一次增量备份，保留七天。'
      + '每季度做一次恢复演练，从快照恢复到一个临时实例，核对行数和最近的写入时间。快照冻结期间写入会短暂变慢，所以排在低峰。备份文件加密后存到另一个可用区，密钥和数据分开保管。',
  },
  {
    id: 'mem_h5e1m8', type: 'knowledge', name: '搜索框防抖',
    summary: '前端搜索输入框防抖 300 毫秒，回车立即搜',
    tags: ['frontend', 'search'],
    content: '列表页的搜索框输入时防抖 300 毫秒再发请求，按回车立即搜索并取消还没发出的防抖请求。'
      + '新请求发出时取消上一个未完成的请求，避免慢的旧结果覆盖新结果。搜索结果为空时显示空状态和清空按钮。输入为空时不发请求，直接回到完整列表；搜索词同步到地址栏，刷新后保留。',
  },
  {
    id: 'mem_r8f2n5', type: 'procedure', name: '密钥轮换',
    summary: '第三方服务的 API 密钥每季度轮换一次',
    tags: ['security', 'secret'],
    content: '第三方支付和短信服务的 API 密钥每季度轮换一次：先在服务商后台生成新密钥，写进密钥管理服务，'
      + '灰度切一半实例确认调用正常，再全量切换，最后在后台吊销旧密钥。密钥不进代码仓库，也不写进日志。轮换当天在运维频道记一笔，写清楚换了哪个服务的哪把密钥。',
  },
  {
    id: 'mem_n3g7o9', type: 'procedure', name: '代码评审清单',
    summary: '合并请求评审时按清单逐项过',
    tags: ['review', 'process'],
    content: '评审合并请求按清单过：需求是否做全、有没有多做；有没有对应的测试；错误处理是否覆盖；'
      + '有没有引入新依赖、理由是否充分；接口变更是否通知了调用方。评审意见分「必须改」和「建议」，作者对每条都要回应。超过四百行的合并请求要求拆小，评审者有权直接退回。',
  },
  {
    id: 'mem_w8h3p1', type: 'knowledge', name: '邮件模板修改',
    summary: '改邮件模板后要重新部署才生效',
    tags: ['email', 'template'],
    content: '通知邮件的模板放在服务的 templates 目录，启动时编译并缓存。改了模板必须重新部署服务才生效，不支持热更新。'
      + '模板里的变量缺失时渲染成空串而不是报错，所以上线前要在预发发一封测试邮件人工检查。模板文案的改动也要经过产品确认，不能只改代码。',
  },
  {
    id: 'mem_c9i5q4', type: 'knowledge', name: '功能开关热更新',
    summary: '功能开关存在配置中心，改了三十秒内生效',
    tags: ['feature-flag', 'config'],
    content: '功能开关放在配置中心，服务每三十秒拉一次，所以改开关后最多三十秒在所有实例上生效，不需要重启。'
      + '新功能默认关闭，先对内部账号打开，再按百分比放量。开关用完要及时删掉，代码里的分支也一起清理。开关名用业务含义命名，例如 checkout_new_flow，不用人名或日期。',
  },
  {
    id: 'mem_s6j9r8', type: 'knowledge', name: '云账单预算告警',
    summary: '云服务月度预算到 80% 时发告警',
    tags: ['cost'],
    content: '云服务每月设预算上限，用到 80% 发告警到运维频道，超出预算时再发一次并抄送负责人。'
      + '上次超支是测试环境的大规格实例忘了关。现在测试环境的实例每晚八点自动关机，需要通宵跑任务的提前在表格里登记。月底前一周会额外发一次用量汇总，列出花费最多的五个服务。',
  },
  {
    id: 'mem_k1l4s7', type: 'knowledge', name: '合并前的检查门禁',
    summary: 'main 分支要求 CI 全绿才能合并',
    tags: ['ci', 'git'],
    content: 'main 分支开了保护：合并请求必须 CI 全绿、至少一个评审通过才能合并，不允许直接推送。'
      + '必需检查的 job 名写在分支保护设置里，改了 CI 里的 job 名要同步改设置，否则合并请求会一直卡在等待检查。'
      + '紧急修复也走同一个门禁，只是评审可以事后补。',
  },
  {
    id: 'mem_y5m2t3', type: 'knowledge', name: '前端侧栏折叠状态',
    summary: '侧栏折叠状态存在本地，刷新后保持',
    tags: ['frontend', 'ux'],
    content: '后台管理页的左侧栏可以折叠，折叠状态存在浏览器本地存储里，刷新和重新登录后保持。'
      + '窄屏下侧栏默认收起，展开时覆盖在内容上方，点外面自动收起。读本地存储要包一层异常处理，隐私模式下可能读不到。侧栏宽度固定 240 像素，折叠后只显示图标，悬停显示文字提示。',
  },
  {
    id: 'mem_f4o8u6', type: 'knowledge', name: '实验结果的置信度',
    summary: 'A/B 实验要到 95% 置信度且跑满一周才下结论',
    tags: ['experiment', 'data'],
    content: 'A/B 实验的结论要同时满足两个条件：主要指标的差异达到 95% 置信度，并且实验跑满一整周，覆盖工作日和周末。'
      + '中途偷看结果提前停止会放大假阳性。样本量在实验开始前按最小可检测差异估算好，写进实验文档。置信度不够时宁可延长实验，也不要换指标。',
  },
  {
    id: 'mem_p7r1v3', type: 'knowledge', name: '子进程的退出处理',
    summary: '派生子进程时要监听退出码和信号，父进程退出时清理',
    tags: ['node', 'process'],
    content: '用 child_process 派生的子进程，要同时监听 exit 和 error 事件，退出码非零时把标准错误输出的最后几行带进错误信息。'
      + '父进程收到终止信号时先给子进程发信号，等两秒还没退出再强制结束，避免留下孤儿进程。',
  },
  {
    id: 'mem_t2x5w4', type: 'knowledge', name: '数据库读写分离',
    summary: '读请求走只读副本，刚写完的读要走主库',
    tags: ['database'],
    content: '数据库配了两个只读副本，普通查询走副本分担主库压力。副本有几百毫秒的复制延迟，'
      + '所以用户刚提交完立刻查看自己数据的请求必须走主库，否则会看到旧数据。报表类慢查询固定走第二个副本，不影响线上读。副本落后超过五秒时自动摘掉，查询全部回到主库并告警。',
  },
  {
    id: 'mem_m9c6y2', type: 'project', name: '项目目录结构',
    summary: '源码按功能模块分目录，测试放在独立的 tests 目录',
    tags: ['structure'],
    content: '项目源码在 src 下按功能模块分目录，每个模块对外只暴露一个入口文件。测试统一放在根目录的 tests 下，'
      + '按被测模块命名，公共的测试工具放 tests/helpers，测试数据放 tests/fixtures。脚本放 scripts，不进发布包。',
  },

  // ---- name 平淡、正文才是主题的记录 ----
  {
    id: 'mem_e3t7z5', type: 'knowledge', name: '周三讨论记录',
    summary: '一次讨论的要点',
    tags: ['meeting'],
    content: '讨论了热点数据的缓存击穿：某个热门商品的缓存过期瞬间，大量请求同时回源打到数据库。'
      + '结论是热点键的回源加互斥锁，只放一个请求去查库并回填，其他请求短暂等待后读缓存；'
      + '同时给热点键的过期时间加随机抖动，避免一批键同时过期造成缓存雪崩。下周压测验证。',
  },
  {
    id: 'mem_o1y9b4', type: 'knowledge', name: '零碎笔记',
    summary: '一些随手记下的东西',
    tags: ['reconnect'],
    content: '客户端 WebSocket 断线后的重连要用指数退避：第一次等一秒，之后每次翻倍，最长三十秒，并加随机抖动，'
      + '免得服务重启后所有客户端同一时刻涌回来。重连成功后先补拉断线期间的消息，再恢复实时推送。'
      + '页面不可见时暂停重连，回到前台立即重试一次。',
  },
  {
    id: 'mem_g6k3c8', type: 'knowledge', name: '杂项',
    summary: '待整理',
    tags: [],
    content: '列表接口的分页改成游标分页：请求带上一页最后一条的 cursor，服务端按排序键往后取，不再用 offset。'
      + 'offset 分页在数据量大时越翻越慢，而且翻页期间有新数据插入会出现重复或漏掉的条目。'
      + 'cursor 用排序键加 id 编码成不透明字符串，前端只透传不解析。',
  },
  {
    id: 'mem_u4b6d9', type: 'knowledge', name: '备忘',
    summary: '临时记一下',
    tags: [],
    content: '上传大文件改成分片上传：前端把文件切成每片 5 MB，并发三片上传，每片带序号和整体文件的 hash。'
      + '服务端收齐后按序号合并，再校验整体 hash；中途失败只重传失败的分片，刷新页面后可以按 hash 查询已传分片继续上传。',
  },
  {
    id: 'mem_a8w4e1', type: 'knowledge', name: '上次排查',
    summary: '一次线上问题的记录',
    tags: ['incident'],
    content: '上次线上接口偶发 502，查了三天。最后发现是服务端 keepAlive 空闲超时比负载均衡的短：'
      + '负载均衡复用了一个服务端已经关闭的连接，请求直接失败。把服务端的空闲超时调到比负载均衡长五秒后再没出现。'
      + '排查时最有用的是对比负载均衡日志和服务端日志的时间戳。',
  },

  // ---- 与上面主题共享高频词的干扰项 ----
  {
    id: 'mem_l6q8f3', type: 'knowledge', name: '缓存键命名',
    summary: '缓存键用冒号分段，带版本号',
    tags: ['cache'],
    content: '缓存键按「业务:实体:id:版本」用冒号分段，例如 order:detail:123:v2。数据结构变化时升版本号，旧键自然过期，'
      + '不用写脚本批量清理。键名里不放用户可控的原始字符串，防止注入和键过长。键名总长控制在一百字符以内，过长的部分取 hash。',
  },
  {
    id: 'mem_q2e5h7', type: 'knowledge', name: '重连按钮文案',
    summary: '断网提示条上的按钮文案',
    tags: ['frontend', 'copy'],
    content: '网络断开时页面顶部显示提示条，文案是「网络已断开，正在重连」，旁边一个「立即重试」按钮。'
      + '用户点了按钮就跳过当前的等待立即尝试。恢复后提示条显示「已恢复」两秒再消失。文案在 locale 文件里，改的时候中英文一起改。提示条不遮挡页面主要操作区，移动端改为底部小条。断线期间的重试间隔由连接层按指数退避计算，文案里不写具体秒数。',
  },
  {
    id: 'mem_v1u7j6', type: 'knowledge', name: '分页组件样式',
    summary: '分页组件的页码与跳转样式',
    tags: ['frontend', 'design', 'pagination'],
    content: '表格下方的分页组件显示首页、上一页、页码、下一页和跳转输入框，页码超过七个时中间用省略号。'
      + '当前页用主色描边，禁用状态的按钮降低透明度。窄屏下只保留上一页、当前页和下一页。组件只负责展示，翻页参数是 offset 还是 cursor 由列表接口决定，组件不关心。每页条数可选 20、50、100。',
  },
  {
    id: 'mem_d3s9i8', type: 'knowledge', name: '上传接口限流',
    summary: '上传接口按用户限流，每分钟二十次',
    tags: ['api', 'rate-limit'],
    content: '上传接口按用户限流，每分钟最多二十次请求，超过返回 429 并在响应头里带重试等待秒数。'
      + '限流计数放在缓存里，按分钟窗口滑动。批量导入走单独的后台任务接口，不受这个限制。限流阈值放在配置文件里，按环境不同；测试环境放宽到每分钟两百次，方便压测。大文件分片上传时每个分片都算一次请求，所以分片上传的页面要单独放宽。',
  },
  {
    id: 'mem_j4n2x6', type: 'knowledge', name: '记忆插件的搜索工具描述',
    summary: '工具描述写清楚什么时候用搜索、什么时候直接读文件',
    tags: ['search', 'prompt'],
    content: '给模型看的工具描述要说清 memory_search 的行为：按相关性排序，中英文都能搜，命中带文件路径（名称含密钥的不带）。'
      + '描述里不写实现细节，比如用了什么分词、怎么打分；写的是模型能据此做决定的信息：什么时候先搜、搜不到怎么办、'
      + '拿到路径后可以直接读全文。',
  },
  {
    id: 'mem_w6c3a2', type: 'knowledge', name: '快照测试的约定',
    summary: '组件快照测试只用于稳定的展示组件',
    tags: ['testing', 'frontend'],
    content: '前端的快照测试只给稳定的纯展示组件用，交互逻辑写成行为测试。快照文件和测试放一起提交，'
      + '更新快照前要看 diff，确认变化是预期的，不能无脑一键更新。快照里出现时间、随机 id 时先在测试里固定它们。快照文件超过三百行说明组件太大，应该拆分。',
  },
  {
    id: 'mem_h1p4k9', type: 'knowledge', name: '发布说明的写法',
    summary: 'CHANGELOG 写给用户看，说清行为变化',
    tags: ['release', 'docs'],
    content: 'CHANGELOG 的读者是用户和外部贡献者，每条写用户能感知的行为变化和原因，不写实现路径。'
      + '按新增、变更、修复、移除分类；还没发版的放在未发布小节，发版时改成版本号加日期。一眼能懂的改动不解释。测试设施的变化也要写一句，说明它现在验证什么。',
  },
  {
    id: 'mem_z5f1o3', type: 'knowledge', name: '会话过期与重新登录',
    summary: '登录会话七天过期，过期后跳登录页并保留原地址',
    tags: ['auth'],
    content: '用户登录会话有效期七天，每次请求滑动续期。会话过期后接口返回 401，前端统一拦截，跳到登录页并带上原来的地址，'
      + '登录成功后回到原页面。表单页过期时先把未提交的内容存到本地，登录回来后恢复。管理员可以在后台强制某个用户的所有会话下线，修改密码后旧会话全部失效。',
  },
  {
    id: 'mem_b9x3r7', type: 'knowledge', name: '工作区设置同步',
    summary: '编辑器工作区设置随仓库提交，个人设置不提交',
    tags: ['editor'],
    content: '编辑器的工作区设置文件随仓库提交，里面只放格式化工具、缩进、行尾这类团队一致的设置。'
      + '个人的主题、字体、快捷键放用户级设置，不进仓库。推荐插件列表也随仓库提交，新人打开项目会收到安装提示。工作区设置里不放任何本机路径，换一台机器打开也能用。',
  },
  {
    id: 'mem_o4m7s1', type: 'knowledge', name: '置信度低的记忆怎么用',
    summary: '模型推断出的记忆置信度 0.5，用之前先向用户确认',
    tags: ['confidence'],
    content: '模型自己推断出来的记忆置信度只有 0.5，注入时在索引行上标「推断」。模型据此行动前应先向用户确认一句，'
      + '用户确认后升到 0.9 并刷新确认时间。长期没被确认的推断记忆，体检会建议删除。推断记忆在搜索结果里同样带「推断」标注，排序时同分情况下排在用户明确说过的记忆之后。',
    confidence: 0.5,
  },
  // ---- 带标点的字面值：版本号、路径、带冒号的标识符；同组记录分词后几乎一样，只差字面值 ----
  // 三条「已知问题」只差版本号，各字段长度相同、查询词频相同：分词打散版本号后同分，按确认时间分不出目标
  {
    id: 'mem_n3s7v2', type: 'knowledge', name: '支付 SDK 3.2.0-rc.2 的已知问题',
    summary: '3.2.0-rc.2 在预发试过，记下问题和绕行办法，升级前先看',
    tags: ['payment', 'sdk'],
    content: '支付 SDK 3.2.0-rc.2 在预发环境接入试过。这一版的问题：回调验签修好了，但退款通知改成批量推送，一次最多二十条。'
      + '绕行办法：退款回调改成逐条幂等落库，单条失败只重试那一条。正式环境升级前，先在预发把下单、回调、退款完整走一遍，确认对账文件能正常解析。',
  },
  {
    id: 'mem_n5s2v6', type: 'knowledge', name: '支付 SDK 3.1.0-rc.2 的已知问题',
    summary: '3.1.0-rc.2 在预发试过，记下问题和绕行办法，升级前先看',
    tags: ['payment', 'sdk'],
    content: '支付 SDK 3.1.0-rc.2 在预发环境接入试过。这一版的问题：对账文件的编码从 GBK 换成了 UTF-8，旧解析脚本读出乱码。'
      + '绕行办法：解析前先按文件头判断编码，两种都能读。正式环境升级前，先在预发把下单、回调、退款完整走一遍，确认对账文件能正常解析。',
  },
  {
    id: 'mem_n4s1v8', type: 'knowledge', name: '支付 SDK 3.2.0-rc.1 的已知问题',
    summary: '3.2.0-rc.1 在预发试过，记下问题和绕行办法，升级前先看',
    tags: ['payment', 'sdk'],
    content: '支付 SDK 3.2.0-rc.1 在预发环境接入试过。这一版的问题：回调验签偶发失败，签名串里的时间戳被截成了秒级。'
      + '绕行办法：验签前把时间戳补齐到毫秒级，或者暂时先停在上一个正式版。正式环境升级前，先在预发把下单、回调、退款完整走一遍，确认对账文件能正常解析。',
  },
  {
    id: 'mem_d2a8h5', type: 'project', name: '设计文档归档',
    summary: '过时的设计文档移进 docs/archive/，不删除',
    tags: ['docs', 'archive'],
    content: '设计文档过时后不删，移进 docs/archive/ 目录，文件名前加上归档日期。archive 下的文档只读，发现里面还有用的段落，就抄回现行文档再改。'
      + '引用设计文档的地方如果指向了 archive 里的旧版，顺手换成现行文档的链接。',
  },
  {
    id: 'mem_i7p2w4', type: 'knowledge', name: '接口鉴权改用短期令牌',
    summary: '/api/v2/ 下的接口改用短期令牌鉴权，令牌十五分钟失效',
    tags: ['api', 'auth'],
    content: '新版接口统一挂在 /api/v2/ 下，鉴权从长期 API key 改成短期令牌：客户端先用 key 换令牌，令牌十五分钟失效，失效前五分钟可以续。'
      + '网关只认令牌，不再接受直接带 key 的请求。服务端校验令牌时顺带检查权限范围，越权直接返回 403。',
  },
  {
    id: 'mem_i6p1w9', type: 'project', name: '旧版接口下线计划',
    summary: '/api/v1/ 在 v2 上线满半年后关闭，之前只修安全漏洞',
    tags: ['api', 'deprecation'],
    content: '旧版接口 /api/v1/ 进入只维护状态：只修安全漏洞，不加新功能。v2 上线满半年后关闭 /api/v1/，关闭前一个月在响应头里加下线提示，'
      + '并给还在调用 v1 的客户逐个发通知。v1 和 v2 的鉴权方式不同，迁移时客户端要先改成换取令牌。',
  },
  {
    id: 'mem_t5d1s3', type: 'procedure', name: '本地测试数据',
    summary: '用 db:seed 灌一套固定的测试数据，账号和订单都是假的',
    tags: ['dev', 'database'],
    content: 'pnpm run db:seed 往本地数据库灌一套固定的测试数据：三个角色各一个账号，外加几十条订单。数据全是假的，可以随便改；想回到初始状态就清掉重灌。'
      + '新增表时顺手在灌数脚本里补几条样例，别让新人对着空表调试。',
  },
  {
    id: 'mem_t6d9r2', type: 'procedure', name: '本地数据库重置',
    summary: 'db:reset 清空本地库后重跑迁移和 seed，只能在本地用',
    tags: ['dev', 'database'],
    content: 'pnpm run db:reset 会删掉本地数据库里的全部表，重跑迁移，再把 seed 数据灌回去，适合迁移写乱了想从头来的时候。'
      + '脚本开头检查连接串，指向的不是本机就直接退出，防止误删共享环境的数据。重置后 seed 里的测试账号密码也会恢复成默认值。',
  },
  // ---- 总览类长记录：一条里提到很多主题，各主题的专门记录才是首选 ----
  {
    id: 'mem_k3d8w2', type: 'project', name: '记忆插件设计总览',
    summary: '存储、注入、检索、治理四块的总体设计，细节见各自的记忆',
    tags: ['design', 'overview'],
    content: '记忆插件分四块。存储：一条记忆一个 markdown 文件，按项目分目录，召回统计放旁路 sidecar，同 id 多副本在读取时统一取舍。'
      + '注入：会话首轮组装快照并冻结，core 类记忆进索引行，受字符预算上限约束，超出时按策略放宽或截断。'
      + '检索：memory_search 分词后按相关性打分，结果分三档，命中带文件路径；memory_source 可以下钻到原始会话。'
      + '治理：体检分三档，规则层查过期、重复、超出上限，语义层找矛盾；发现的问题、提升候选、硬删除说明都进待处理列表，'
      + 'GUI 侧栏在对应记忆行上标出冲突。权限上，子代理只读，跨工作区读取要过门禁，含密钥的记忆直接硬删除。'
      + '模板决定有哪些记忆类型，切换后立即生效。每一块的细节各有单独的记忆，这条只做索引，内容以单独的记忆为准。',
  },
  {
    id: 'mem_f9t2c6', type: 'project', name: '新人上手须知',
    summary: '新加入项目的人第一周要知道的约定',
    tags: ['onboarding', 'overview'],
    content: '第一天按本地开发环境的步骤起数据库容器、跑迁移、起开发服务器。包管理只用 pnpm。'
      + '提交信息用 Conventional Commits，合并请求按评审清单自查，main 分支有检查门禁，CI 全绿才能合并。'
      + '测试里不 mock 数据库，遇到 flaky 测试先隔离再修。配置按默认值、配置文件、环境变量三层加载。'
      + '日志不打印手机号、邮箱、token。上线先预发再全量，失败就回滚，周五下午不做全量上线。时间一律存 UTC。'
      + '界面文案放 locale 文件，不写死在代码里。不确定的接口问题先问后端负责人，设计稿看共享画布。'
      + '以上每条都有单独的记忆写了细节，遇到具体问题搜对应的那条。',
  },
  {
    id: 'mem_r6v1y8', type: 'knowledge', name: '检索改动摘要',
    summary: '这一版 memory_search 的整体变化',
    tags: ['search', 'overview'],
    content: '这一版检索的改动：查询先分词，中文默认用词典分词，依赖装不上时退回二字切分；英文与标识符按驼峰、下划线拆成子词。'
      + '打分用 BM25，name、summary、tags、content 分字段加权，idf 取恒正的变体。结果分三档：全命中、部分命中、只有子串命中，'
      + '档内按分数排，同分按置信度和最近确认时间。没有全命中时附一句说明。命中带记忆文件的绝对路径（名称含密钥的不带），返回全文不截片段。'
      + '用户词典通过 userDictionaryPath 配置，追加到主词典。查询恰好等于某个 id 时该条排第一。空查询不过滤，按置信度排序。'
      + '读取走 readScope，按范围读并带预筛词，listedCount 作为 BM25 的文档数。',
  },
  {
    id: 'mem_x2k9m4', type: 'knowledge', name: '互斥锁的用法',
    summary: '进程内并发用互斥锁保护共享状态',
    tags: ['concurrency', 'node', 'mutex'],
    content: 'Node 是单线程的，但异步操作交错时共享状态仍会被并发修改。进程内用一个基于 Promise 的互斥锁把临界区串起来：'
      + '拿到锁才读改写，结束后释放。锁要配超时，持有方抛错也要在 finally 里释放。'
      + '跨进程的场景用文件锁或数据库的行锁；它和缓存击穿时用的分布式锁是两回事，不要混用一套实现。',
  },
]

/** 统一的时间基准：确认时间按数组下标递增，零 token 查询的预期顺序因此是确定的。 */
const BASE_MS = 1_760_000_000_000

export const EVAL_RECORDS: MemoryRecord[] = MEMORIES.map((m, i) => ({
  id: m.id,
  name: m.name,
  type: m.type,
  scope: 'global',
  tags: m.tags,
  content: m.content,
  summary: m.summary,
  source: { sessionId: 'eval', eventRange: [0, 1], sourceMode: 'user-explicit' },
  createdAt: BASE_MS,
  updatedAt: BASE_MS,
  lastConfirmedAt: m.lastConfirmedAt ?? BASE_MS + i * 1000,
  lastRecalledAt: null,
  recallCount: 0,
  status: 'active',
  confidence: m.confidence ?? 0.9,
}))

export const EVAL_CATEGORIES = [
  'short-cjk', 'long-cjk', 'identifier', 'partial-word', 'plain-name', 'id-direct', 'zero-token', 'anchor', 'paraphrase',
  'bilingual', 'bilingual-no-alias', 'no-answer', 'long-answerable', 'long-no-answer',
] as const
export type EvalCategory = (typeof EVAL_CATEGORIES)[number]

/** 只记录基线、不进回归门槛的类别：换说法查询量的是字面匹配够不着的地方，分数低是预期。 */
export const BASELINE_ONLY_CATEGORIES: readonly EvalCategory[] = ['paraphrase']

/**
 * 逐条设门槛的类别：每条查询两档都必须第一名命中，不计入聚合下限。
 * 锚点类（带标点的字面值）靠字面整词命中排序键定第一名，结果是确定的，掉一条就是规则坏了，不留余量。
 */
export const STRICT_CATEGORIES: readonly EvalCategory[] = ['anchor']

/**
 * 只用来评估「命中弱」判定的类别，不进排序指标：
 * - 换语言查（bilingual）：答案记忆用中文写、标签里存了英文别名（memory_save 要求的），查询只写英文：应全命中、不判弱；
 * - 换语言查、记忆没存别名（bilingual-no-alias）：答案记忆只有中文写法，查询写英文：应判弱，提示换成另一种语言再搜；
 * - 库里没有答案（no-answer）：查询里有常见词能部分命中，但没有一条记忆讲这件事，relevant 为空；
 * - 长句提问（long-answerable / long-no-answer）：按日常说话的口气整句提问，前者库里有答案，后者没有（relevant 为空）。
 */
export const NOTE_ONLY_CATEGORIES: readonly EvalCategory[] = ['bilingual', 'bilingual-no-alias', 'no-answer', 'long-answerable', 'long-no-answer']

/**
 * 换说法的四种方式：同义词（自动关机 / 定时关停）、上下位词（数据库 / Postgres）、
 * 中英混写（热更新 / hot reload）、口语化描述。
 */
export const PARAPHRASE_KINDS = ['synonym', 'hypernym', 'mixed-lang', 'colloquial'] as const
export type ParaphraseKind = (typeof PARAPHRASE_KINDS)[number]

export interface EvalQuery {
  query: string
  category: EvalCategory
  /**
   * 可接受的答案（人工判读的相关记录 id，不是跑出来的结果）。
   * top-1 命中：第一名在其中；top-3 命中：前三名至少一条在其中。
   */
  relevant: readonly string[]
  /** 仅 paraphrase 类：这条查询用的是哪种换说法。 */
  paraphrase?: ParaphraseKind
}

/** 零 token 查询不过滤、按 confidence、lastConfirmedAt 排：预期第一名是数组里最后一条 0.9 的记录。 */
const NEWEST_CONFIDENT = EVAL_RECORDS.filter(r => r.confidence === 0.9).at(-1)!.id

export const EVAL_QUERIES: readonly EvalQuery[] = [
  // 短中文
  { query: '快照冻结耗时', category: 'short-cjk', relevant: ['mem_k7q2a1'] },
  { query: '密钥硬删除', category: 'short-cjk', relevant: ['mem_p9w3c4'] },
  { query: '子代理只读', category: 'short-cjk', relevant: ['mem_h2m6d8'] },
  { query: '模板热生效', category: 'short-cjk', relevant: ['mem_t6y2h4'] },
  { query: '注入预算超出上限', category: 'short-cjk', relevant: ['mem_z3b7g9'] },
  { query: '按置信度排序', category: 'short-cjk', relevant: ['mem_y4j3u8'] },
  { query: '体检的自动档位', category: 'short-cjk', relevant: ['mem_j1u5k8'] },
  { query: '侧栏里的冲突记忆', category: 'short-cjk', relevant: ['mem_v3f9r6'] },
  { query: '待处理决定的提醒', category: 'short-cjk', relevant: ['mem_n6g2s9'] },
  { query: '回源', category: 'short-cjk', relevant: ['mem_e3t7z5', 'mem_e5j2f9'] },
  { query: '错误码分段', category: 'short-cjk', relevant: ['mem_v9k1e7'] },
  // 长中文句
  { query: '记忆文件手编后出处对不上怎么办', category: 'long-cjk', relevant: ['mem_c5n1e3'] },
  { query: '同一个 id 有多个副本时怎么取舍', category: 'long-cjk', relevant: ['mem_x8v4f6'] },
  { query: '宿主插件页的配置表单是怎么声明的', category: 'long-cjk', relevant: ['mem_s4i9l2'] },
  { query: '发版步骤和 npm 发布要注意什么', category: 'long-cjk', relevant: ['mem_f7o3m5'] },
  { query: '钉版的宿主版本与 peer 下界是什么关系', category: 'long-cjk', relevant: ['mem_g2p8n1'] },
  { query: '挑战式评审发现了哪些问题', category: 'long-cjk', relevant: ['mem_d9a4o7'] },
  { query: '两个进程并发写入时脱敏要串行化吗', category: 'long-cjk', relevant: ['mem_e8d6q2'] },
  { query: '项目里的记忆怎么提升到全局', category: 'long-cjk', relevant: ['mem_q7k8v1'] },
  { query: '搜索结果返回全文还是片段', category: 'long-cjk', relevant: ['mem_m2l5w7'] },
  { query: '工作区目录名是怎么算出来的', category: 'long-cjk', relevant: ['mem_u9z6x3'] },
  { query: '为什么召回次数不写进记忆文件里', category: 'long-cjk', relevant: ['mem_r1f3e5', 'mem_w5s1p3'] },
  { query: '上线后发现表结构不兼容怎么回退', category: 'long-cjk', relevant: ['mem_h9c1l3'] },
  { query: '测试环境的机器晚上会自动关吗', category: 'long-cjk', relevant: ['mem_s6j9r8'] },
  { query: '模型自己推断出来的记忆能直接用吗', category: 'long-cjk', relevant: ['mem_o4m7s1'] },
  // 标识符
  { query: 'memory_source 下钻原始会话', category: 'identifier', relevant: ['mem_i3x1y5'] },
  { query: 'readScope 读取范围', category: 'identifier', relevant: ['mem_o6c4z2'] },
  { query: 'requestTimeoutMs', category: 'identifier', relevant: ['mem_q9u3x7'] },
  { query: 'globalCandidate', category: 'identifier', relevant: ['mem_q7k8v1'] },
  { query: 'userDictionaryPath', category: 'identifier', relevant: ['mem_c2w9d1'] },
  // 部分词与词形变化
  { query: 'deploy', category: 'partial-word', relevant: ['mem_d6x2k7'] },
  { query: 'migration', category: 'partial-word', relevant: ['mem_m4v7n2'] },
  { query: 'timeout', category: 'partial-word', relevant: ['mem_q9u3x7', 'mem_a8w4e1'] },
  { query: 'config 加载顺序', category: 'partial-word', relevant: ['mem_k5t9s4'] },
  { query: 'recall', category: 'partial-word', relevant: ['mem_r1f3e5'] },
  { query: '新鲜', category: 'partial-word', relevant: ['mem_b1h7t4'] },
  { query: '手机', category: 'partial-word', relevant: ['mem_x6r2w9'] },
  { query: 'mem_x8v4', category: 'partial-word', relevant: ['mem_x8v4f6'] },
  // name 平淡、正文命中
  { query: '缓存击穿 互斥锁', category: 'plain-name', relevant: ['mem_e3t7z5'] },
  { query: '断线重连 指数退避', category: 'plain-name', relevant: ['mem_o1y9b4'] },
  { query: '游标分页 cursor offset', category: 'plain-name', relevant: ['mem_g6k3c8'] },
  { query: '大文件分片上传', category: 'plain-name', relevant: ['mem_u4b6d9'] },
  { query: '偶发 502 负载均衡 keepAlive', category: 'plain-name', relevant: ['mem_a8w4e1', 'mem_q9u3x7'] },
  { query: '热门商品缓存过期的瞬间请求全打到数据库', category: 'plain-name', relevant: ['mem_e3t7z5'] },
  // id 直达
  { query: 'mem_x8v4f6', category: 'id-direct', relevant: ['mem_x8v4f6'] },
  { query: ' mem_o4m7s1 ', category: 'id-direct', relevant: ['mem_o4m7s1'] },
  // 零 token
  { query: '', category: 'zero-token', relevant: [NEWEST_CONFIDENT] },
  { query: '   ', category: 'zero-token', relevant: [NEWEST_CONFIDENT] },
  // 锚点：带标点的字面值（版本号、路径、带冒号的标识符），分词会把它打散
  { query: '3.2.0-rc.2', category: 'anchor', relevant: ['mem_n3s7v2'] },
  { query: '3.2.0-rc.1', category: 'anchor', relevant: ['mem_n4s1v8'] },
  { query: '3.1.0-rc.2', category: 'anchor', relevant: ['mem_n5s2v6'] },
  { query: '支付 SDK 3.2.0-rc.2 已知问题', category: 'anchor', relevant: ['mem_n3s7v2'] },
  { query: '.archive/', category: 'anchor', relevant: ['mem_p9w3c4'] },
  { query: 'docs/archive/', category: 'anchor', relevant: ['mem_d2a8h5'] },
  { query: '/api/v2/', category: 'anchor', relevant: ['mem_i7p2w4'] },
  { query: '/api/v1/', category: 'anchor', relevant: ['mem_i6p1w9'] },
  { query: 'db:seed', category: 'anchor', relevant: ['mem_t5d1s3'] },
  { query: 'db:reset', category: 'anchor', relevant: ['mem_t6d9r2'] },
  { query: 'host:contract', category: 'anchor', relevant: ['mem_f7o3m5'] },
  // 换说法：只看 name 列表写查询，再对照全文标注；主要实词不出现在相关记忆的四个字段里（tests/search-eval.spec.ts 检查）。
  // 只记基线，不进回归门槛。总览类记录（设计总览、新人上手须知）按惯例不算相关。
  { query: '上云开销超标的通知', category: 'paraphrase', paraphrase: 'synonym', relevant: ['mem_s6j9r8'] },
  { query: '健康诊断分几挡', category: 'paraphrase', paraphrase: 'synonym', relevant: ['mem_j1u5k8'] },
  { query: '代码入库说明的书写规范', category: 'paraphrase', paraphrase: 'synonym', relevant: ['mem_f1q5p8'] },
  { query: '凭据定期更换', category: 'paraphrase', paraphrase: 'synonym', relevant: ['mem_r8f2n5'] },
  { query: '访问别家仓库的内容需要授权吗', category: 'paraphrase', paraphrase: 'synonym', relevant: ['mem_r4t8b2'] },
  { query: 'MySQL dump 保存期限', category: 'paraphrase', paraphrase: 'hypernym', relevant: ['mem_b4d8l7'] },
  { query: 'Node 生态装库用哪家', category: 'paraphrase', paraphrase: 'hypernym', relevant: ['mem_p3n8j4'] },
  { query: '单测里用 Postgres 实例还是假对象', category: 'paraphrase', paraphrase: 'hypernym', relevant: ['mem_a3c6b8'] },
  { query: 'Redis 的 key 何时作废', category: 'paraphrase', paraphrase: 'hypernym', relevant: ['mem_e5j2f9', 'mem_l6q8f3'] },
  { query: 'Vite 还是 webpack', category: 'paraphrase', paraphrase: 'hypernym', relevant: ['mem_y1z8a3'] },
  { query: 'spawn 出来的程序挂掉后收尾', category: 'paraphrase', paraphrase: 'mixed-lang', relevant: ['mem_p7r1v3'] },
  { query: '打字时 debounce 延迟设多长', category: 'paraphrase', paraphrase: 'mixed-lang', relevant: ['mem_h5e1m8'] },
  { query: 'toggle 修改后无需发版即可起效', category: 'paraphrase', paraphrase: 'mixed-lang', relevant: ['mem_c9i5q4'] },
  { query: 'memory leak 怎么定位', category: 'paraphrase', paraphrase: 'mixed-lang', relevant: ['mem_z7a4k1'] },
  { query: '输出 verbosity 正式部署设成哪档', category: 'paraphrase', paraphrase: 'mixed-lang', relevant: ['mem_x6r2w9'] },
  { query: '在自己电脑上把项目跑起来', category: 'paraphrase', paraphrase: 'colloquial', relevant: ['mem_c4h7d5'] },
  { query: '上下文塞不下了会怎样', category: 'paraphrase', paraphrase: 'colloquial', relevant: ['mem_z3b7g9'] },
  { query: '找服务端老大对接有什么讲究', category: 'paraphrase', paraphrase: 'colloquial', relevant: ['mem_j8b4t6'] },
  { query: '视觉稿一般在哪儿看', category: 'paraphrase', paraphrase: 'colloquial', relevant: ['mem_s3y7u1'] },
  { query: '老条目还靠不靠谱', category: 'paraphrase', paraphrase: 'colloquial', relevant: ['mem_b1h7t4', 'mem_s9h4f2'] },
  // 换语言查：中文记忆的标签里存了英文别名，查询只写英文（判弱评估用，不进排序指标）
  { query: 'reconnect', category: 'bilingual', relevant: ['mem_o1y9b4'] },
  { query: 'mutex', category: 'bilingual', relevant: ['mem_x2k9m4', 'mem_e3t7z5'] },
  { query: 'pagination', category: 'bilingual', relevant: ['mem_v1u7j6'] },
  // 换语言查、记忆没存别名：只有中文写法，查询写英文，应判弱（判弱评估用，不进排序指标）
  { query: 'rotation 密钥', category: 'bilingual-no-alias', relevant: ['mem_r8f2n5'] },
  { query: 'memory leak', category: 'bilingual-no-alias', relevant: ['mem_z7a4k1'] },
  { query: 'read replica', category: 'bilingual-no-alias', relevant: ['mem_t2x5w4'] },
  { query: 'debounce 毫秒', category: 'bilingual-no-alias', relevant: ['mem_h5e1m8'] },
  // 库里没有答案：有常见词能部分命中，但没有记忆讲这件事（判弱评估用，结果应全部判弱）
  { query: '数据库 分库分表', category: 'no-answer', relevant: [] },
  { query: '前端 埋点 上报', category: 'no-answer', relevant: [] },
  { query: '周报 模板', category: 'no-answer', relevant: [] },
  { query: 'Python 虚拟环境', category: 'no-answer', relevant: [] },
  { query: '定时任务 cron 配置', category: 'no-answer', relevant: [] },
  { query: '灰度发布 监控告警', category: 'no-answer', relevant: [] },
  { query: '线上报错 Sentry 接入', category: 'no-answer', relevant: [] },
  { query: '证书 过期 续期', category: 'no-answer', relevant: [] },
  // 长句提问、库里有答案（判弱评估用，不进排序指标）
  { query: '接口超时时间设置成多少了', category: 'long-answerable', relevant: ['mem_q9u3x7'] },
  { query: '数据库备份保留多少天', category: 'long-answerable', relevant: ['mem_b4d8l7'] },
  { query: '提交信息应该用什么格式写', category: 'long-answerable', relevant: ['mem_f1q5p8'] },
  { query: '第三方密钥多久轮换一次', category: 'long-answerable', relevant: ['mem_r8f2n5'] },
  { query: '上传接口每分钟限流多少次', category: 'long-answerable', relevant: ['mem_d3s9i8'] },
  { query: '登录会话多久会过期', category: 'long-answerable', relevant: ['mem_z5f1o3'] },
  { query: '功能开关改了以后多久能生效', category: 'long-answerable', relevant: ['mem_c9i5q4'] },
  { query: '时间在数据库里应该怎么存', category: 'long-answerable', relevant: ['mem_l2n6g4'] },
  { query: '前端搜索框的防抖设了多少毫秒', category: 'long-answerable', relevant: ['mem_h5e1m8'] },
  { query: '更新数据的时候先删缓存还是先写库', category: 'long-answerable', relevant: ['mem_e5j2f9'] },
  { query: '依赖一般多久集中升级一次', category: 'long-answerable', relevant: ['mem_i6t9j2'] },
  // 长句提问、库里没有答案：常见词能部分命中（判弱评估用，结果应全部判弱）
  { query: '前端埋点数据怎么上报到服务端', category: 'long-no-answer', relevant: [] },
  { query: '周报模板应该放在哪个目录', category: 'long-no-answer', relevant: [] },
  { query: '定时任务的执行时间怎么配置', category: 'long-no-answer', relevant: [] },
  { query: '生产环境的服务器一共有几台', category: 'long-no-answer', relevant: [] },
  { query: '移动端推送证书什么时候过期', category: 'long-no-answer', relevant: [] },
  { query: '图片上传之后要不要压缩', category: 'long-no-answer', relevant: [] },
  { query: '单元测试覆盖率要求达到多少', category: 'long-no-answer', relevant: [] },
  { query: '订单表的分库分表规则是什么', category: 'long-no-answer', relevant: [] },
  { query: '线上日志要保留多少天', category: 'long-no-answer', relevant: [] },
  { query: '接口文档放在哪个平台上维护', category: 'long-no-answer', relevant: [] },
]
