import type { RawEvent, SessionLog } from '../../src/session-log.ts'

/** 全部会话均为自造；事件可直接交给收录函数，不依赖时钟或文件系统。 */
export interface EvalSession { log: SessionLog; scene: 'work' | 'daily' }
/** 正文和出处一起提供，供补找与原话去重评测使用。 */
export interface EvalMemory {
  id: string
  name: string
  summary: string
  body: string
  sessionId: string
  eventRange: [number, number]
}
/** 每类五题；换说法题只用于观察基线，不参与参数选择。 */
export const DIALOGUE_EVAL_CATEGORIES = [
  'bigram', 'single-char', 'mixed', 'identifier', 'fullwidth', 'cross-word',
  'before-anchor', 'near-verbatim', 'long-message', 'tool-result', 'paraphrase', 'no-answer',
] as const
/** 答案按消息标注；同一消息切成多段后仍只算一道题命中。 */
export interface DialogueEvalQuery {
  id: string
  category: (typeof DIALOGUE_EVAL_CATEGORIES)[number]
  scene: 'work' | 'daily'
  query: string
  answers: readonly { sessionId: string; seq: number }[]
  distractors?: readonly { sessionId: string; seq: number }[]
  anchorMemoryId?: string
}

interface Case {
  query: string
  answer: string
  distractor?: string
}
interface Scene {
  topic: string
  context: readonly [string, string][]
  cases: readonly Case[]
}

// 每组前三份办公、后两份日常；题目正文独立写定，不从检索结果反推答案。
const scenes: readonly Scene[] = [
  {
    topic: '导入队列排错',
    context: [
      ['导入刚到一半就停了，先查哪层？', '先看队列是否还在消费，再看落盘是否失败。'],
      ['重放会不会写出两份？', '保留批次号，重复批次只确认收到。'],
      ['并发要不要先降下来？', '先保留单路消费，便于复现相同的输入顺序。'],
      ['怎么记录这次排错？', '把输入规模、退出状态和重放步骤写进排错笔记。'],
    ],
    cases: [
      { query: '阻塞', answer: '导入阻塞发生在两个写任务互相等待批次确认时。' },
      { query: '锁', answer: '这里的锁只保护批次提交，不保护整个扫描过程。' },
      { query: 'worker 重试', answer: 'worker 重试前要释放旧连接，否则连接池会耗尽。' },
      { query: 'retryDelayMs', answer: 'retryDelayMs 放在 src/import/queue.ts，单位是毫秒。' },
    ],
  },
  {
    topic: '配置迁移',
    context: [
      ['旧配置还要保留多久？', '先留一个兼容周期，读取时记录旧字段是否仍在使用。'],
      ['默认值在哪里写？', '默认值集中到配置入口，业务模块只接收解析后的对象。'],
      ['迁移失败如何恢复？', '先校验新文件，再替换旧文件；失败时继续读取旧内容。'],
      ['文档怎么分段？', '先写默认行为，再写覆盖方式，最后列迁移示例。'],
    ],
    cases: [
      { query: '回滚', answer: '配置回滚依赖替换前留下的只读副本。' },
      { query: '税', answer: '报价配置里的税按含税总价展示，不能再次加到合计里。' },
      { query: 'cache 失效', answer: 'cache 失效以配置修订号变化为准。' },
      { query: 'cache_ttl', answer: 'cache_ttl 的缺省值为六十秒，零表示每次重读。' },
    ],
  },
  {
    topic: '文档发布排期',
    context: [
      ['上线说明要包含哪些内容？', '列新增行为、迁移步骤和已知限制。'],
      ['排期先排哪项？', '先校验示例命令，再安排排版检查。'],
      ['链接坏了怎么处理？', '保留错误清单，修复后逐个重新打开验证。'],
      ['谁来收尾？', '值班编辑负责合并文字，维护者确认示例输出。'],
    ],
    cases: [
      { query: '排期', answer: '文档排期留两天给示例核验，周四才做版式检查。' },
      { query: '章', answer: '入门章只讲首次运行，排错细节放到附录。' },
      { query: 'preview 目录', answer: 'preview 目录只放临时预览，不作为下载入口。' },
      { query: 'v2.4.1', answer: 'v2.4.1 的发布说明要注明旧参数仍可读取。' },
    ],
  },
  {
    topic: '周末出行',
    context: [
      ['周末去山边还是河边？', '河边步道平坦，带长辈走起来轻松一些。'],
      ['午饭在哪里解决？', '带饭团和温水，找有遮阴的休息点。'],
      ['如果下雨呢？', '改去室内展馆，不把雨天安排和晴天路线混在一起。'],
      ['出发前还要检查什么？', '确认车票、随身包和返程时间。'],
    ],
    cases: [
      { query: '雨伞', answer: '雨伞放在背包右侧袋，不放行李箱。' },
      { query: '钥', answer: '备用钥挂在蓝色小布袋里，交给同行家人保管。' },
      { query: 'check-in 提前', answer: '这次 check-in 提前半小时办，给找站台留余量。' },
      { query: '~/project/trip/list.txt', answer: '出行清单的示例路径是 ~/project/trip/list.txt。' },
    ],
  },
  {
    topic: '厨房采购',
    context: [
      ['这一周准备做什么菜？', '先安排蒸菜和汤，减少工作日晚上的准备时间。'],
      ['蔬菜怎么买？', '叶菜分两次买，根茎类可以一次备齐。'],
      ['冰箱怎么分区？', '即食食物放上层，生食密封后放下层。'],
      ['还缺什么厨具？', '先量抽屉深度，再决定量勺是否能收进去。'],
    ],
    cases: [
      { query: '燕麦', answer: '燕麦买无糖厚片，早上泡软后再加牛奶。' },
      { query: '盐', answer: '盐放在灶台左侧的小陶罐里。' },
      { query: 'meal prep 分装', answer: 'meal prep 分装用浅盒，每盒只装一餐。' },
      { query: 'size.small', answer: '饭盒标签 size.small 对应带水果的那只浅盒。' },
    ],
  },
  {
    topic: '服务端命名讨论',
    context: [
      ['路由层还要做校验吗？', '入口检查格式，业务层检查状态条件。'],
      ['错误如何呈现？', '给调用方稳定的错误码，日志补充具体上下文。'],
      ['命名讨论先看什么？', '先列每个字段的含义，再比较名称是否容易混淆。'],
      ['接口说明要放在哪里？', '和契约一起维护，示例必须能对应实际字段。'],
    ],
    cases: [
      { query: 'API V2', answer: '兼容入口的铭牌写成 ＡＰＩ Ｖ２，正式说明也沿用了这个写法。' },
      { query: '和服', answer: '测试商店的和服分类归入传统衣饰。', distractor: '这次同步修改客户端和服务端的校验提示。' },
      { query: '服务端命名为何保留旧字段', answer: '服务端命名保留旧字段的原因：离线客户端仍会补交旧格式。' },
      { query: '入口只负责格式校验', answer: '入口只负责格式校验，库存状态由订单模块判断。' },
    ],
  },
  {
    topic: '地图组件调试',
    context: [
      ['缩放后标记跑偏了。', '把坐标转换和画布偏移分别记录，先确认偏差来源。'],
      ['地图文字密度太高。', '先限制低缩放级别显示的标签种类。'],
      ['鼠标拖动还要跟踪吗？', '只在拖动期间记录事件，结束后停止。'],
      ['错误截图怎样存？', '截图旁边写下缩放级别和窗口尺寸。'],
    ],
    cases: [
      { query: 'B12', answer: '复现标记的编号是 Ｂ１２，位于示例地图北侧。' },
      { query: '市长', answer: '市长在示例公告里要求开放河畔步道。', distractor: '地图测试标签写着南京市长江大桥，缩放后仍应完整显示。' },
      { query: '地图标记偏移的原因', answer: '地图标记偏移的原因是画布缩放后又重复乘了一次像素比例。' },
      { query: '拖动结束停止记录', answer: '拖动结束停止记录，截图统一保存为灰底预览。' },
    ],
  },
  {
    topic: '报表验收',
    context: [
      ['月报表要怎么验？', '先核对行数，再对照每个分组的小计。'],
      ['空值显示什么？', '空值显示短横线，零仍显示数字。'],
      ['导出文档如何分页？', '表头随页重复，备注留在最后一页。'],
      ['验收顺序定了吗？', '先核数，再查格式，最后检查导出文件。'],
    ],
    cases: [
      { query: 'Ｒ３', answer: '报表模板 R3 的备注区改为两栏。' },
      { query: '人才', answer: '人才报表统计新入职与离职人数。', distractor: '这个按钮只有负责人才能看见。' },
      { query: '报表为何保留空行', answer: '报表保留空行是为了让打印页码与归档索引保持一致。' },
      { query: '空值短横线零显示数字', answer: '归档表的空值显示短横线，零显示数字并保留两位小数。' },
    ],
  },
  {
    topic: '家人聚餐',
    context: [
      ['聚餐桌位怎么安排？', '长辈坐靠里侧，给推车留出通道。'],
      ['菜量是不是太多？', '先按人数点主菜，主食可以后加。'],
      ['朋友会晚到。', '把凉菜先上，热菜等人齐再做。'],
      ['饭后安排什么？', '附近散步一小圈，觉得累就直接回去。'],
    ],
    cases: [
      { query: 'C08', answer: '聚餐的桌牌写着 Ｃ０８，靠窗但不临街。' },
      { query: '花生', answer: '家人明确说花生不放进这次聚餐的凉菜。', distractor: '阳台的桂花生长得慢，先检查盆土。' },
      { query: '聚餐为什么不要靠门', answer: '聚餐不要靠门的原因是长辈怕门口穿堂风。' },
      { query: '热菜等人齐', answer: '凉菜先上，热菜等人齐再做，主食最后点。' },
    ],
  },
  {
    topic: '睡前习惯',
    context: [
      ['晚上总想继续刷屏。', '先把充电位置挪到书桌，床边只留纸书。'],
      ['睡前想喝点东西。', '准备一小杯温水，避免临睡前喝太多。'],
      ['要不要记录入睡时间？', '记大致时段和第二天感受，先观察习惯。'],
      ['周末要继续执行吗？', '尽量保持同样的起床时段，不额外安排早会。'],
    ],
    cases: [
      { query: 'LED 2', answer: '卧室灯的档位标签是 ＬＥＤ ２，睡前只用这一档。' },
      { query: '马上', answer: '提醒响起就马上把手机放回书桌。', distractor: '故事里的小木马上涂了蓝色颜料。' },
      { query: '睡前为什么不听节目', answer: '睡前不听节目的原因是会忍不住把下一集也听完。' },
      { query: '床边只留纸书', answer: '手机在书桌充电，床边只留纸书和一杯温水。' },
    ],
  },
  {
    topic: '导出故障分析',
    context: [
      ['导出卡在哪里？', '先按准备、读取、写出三个阶段分别记录耗时。'],
      ['小文件能成功。', '再试有长字段的输入，观察是否只与内容长度有关。'],
      ['临时文件需要留下吗？', '失败样本留下用于复现，成功样本完成后清理。'],
      ['如何确认修复？', '用同一份输入比较输出总行数和最后一行。'],
    ],
    cases: [
      { query: '游标恢复点', answer: '游标恢复点必须放在最后一次成功写出的记录之后。' },
      { query: 'E_EXPORT_CURSOR', answer: 'E_EXPORT_CURSOR：恢复位置超过输入长度，导出终止。' },
      { query: '为什么断了以后接着导出会漏几行？', answer: '中断后续传漏行，是因为进度记录比实际写出提前提交。' },
      { query: '宿主注入的环境标记', answer: '导出说明只列现有格式和字段类型。' },
    ],
  },
  {
    topic: '缓存容量检查',
    context: [
      ['缓存占用怎么核对？', '分别统计索引、正文和过期项。'],
      ['清理时要暂停读吗？', '读取持有旧快照，清理生成下一份快照。'],
      ['容量不足怎么提示？', '提示需要的空间和当前可用空间。'],
      ['压测后还看什么？', '检查清理前后命中率与峰值内存。'],
    ],
    cases: [
      { query: '淘汰顺序', answer: '淘汰顺序先看最近访问时间，同时间再按记录编号。' },
      { query: '可用页数', answer: '检查结果：可用页数为 48，索引页数为 12。' },
      { query: '刚看过的内容为什么不会被先删掉？', answer: '清理会保留最近访问过的条目，优先删很久没打开的内容。' },
      { query: '委派任务验收编号', answer: '容量检查只输出使用量，不包含设备身份信息。' },
    ],
  },
  {
    topic: '表单错误提示',
    context: [
      ['提交失败提示不清楚。', '将字段错误显示在输入框旁，整体状态留在页头。'],
      ['编辑时要清除错误吗？', '对应字段重新通过校验后再清除。'],
      ['颜色之外还有标识吗？', '给错误添加文字说明，键盘焦点能移动到首个错误。'],
      ['说明文案怎么验收？', '把常见错误逐条触发，检查提示是否指出修正动作。'],
    ],
    cases: [
      { query: '焦点回到首个无效字段', answer: '提交失败后，焦点回到首个无效字段，已填写内容保留。' },
      { query: 'E_FORM_EMPTY', answer: 'E_FORM_EMPTY：必填项为空，拒绝提交。' },
      { query: '填错之后其他内容还要重填吗？', answer: '校验失败时保留其余输入，只要求修正有问题的那一项。' },
      { query: '表单作者的私人电话号码', answer: '帮助页只提供操作说明。' },
    ],
  },
  {
    topic: '露营购物',
    context: [
      ['帐篷怎么选尺寸？', '按睡垫展开后的宽度算，再留出行李空间。'],
      ['灯具准备几盏？', '桌面照明和走路照明分开准备。'],
      ['朋友带炉具。', '先确认燃料规格，避免现场接口不匹配。'],
      ['收纳先装什么？', '重物放靠近背部的位置，雨具放容易拿到的地方。'],
    ],
    cases: [
      { query: '地垫收边', answer: '地垫收边要折进帐篷底部，避免边缘接住雨水。' },
      { query: '气阀漏气', answer: '检查结果：气阀漏气，垫子未通过保压。' },
      { query: '买的垫子怎么老是睡一会就瘪？', answer: '充气垫的阀盖没有拧紧，静置后会慢慢变软。' },
      { query: '露营清点暗格编号', answer: '行程清单只安排搭帐篷和步行。' },
    ],
  },
  {
    topic: '运动与休息',
    context: [
      ['这周怎么安排活动？', '把散步放在饭后，忙的时候缩短路线。'],
      ['鞋子有点磨脚。', '先换宽松的袜子，检查是否有硬边顶住脚背。'],
      ['朋友邀约长距离徒步。', '先说明自己的安排，量力选择较短路线。'],
      ['活动记录写什么？', '记录大致时长、路线和疲劳感，不追求每天刷新数字。'],
    ],
    cases: [
      { query: '休息日安排', answer: '休息日安排在两次长步行之间，只做轻松拉伸。' },
      { query: '步数统计', answer: '步数统计：本次 4200 步，记录已保存。' },
      { query: '为什么约朋友时总挑短路线？', answer: '长距离走完会影响第二天精神，所以聚会选短路线。' },
      { query: '上次血液检查的具体数值', answer: '活动笔记仅记录主观感受和步行安排。' },
    ],
  },
]

// 固定起点只保证相对时序；不绑定生成当天或真实会话日期。
const T0 = 1_000_000
const sessions: EvalSession[] = []
const memories: EvalMemory[] = []
const queries: DialogueEvalQuery[] = []

for (const [index, scene] of scenes.entries()) {
  const sessionId = `dialogue-${index + 1}`
  const kind = index % 5 < 3 ? 'work' : 'daily'
  const events: RawEvent[] = []
  const refs = new Map<number, number>()
  const starts: number[] = []
  const ends: number[] = []
  let distractorSeq: number | undefined
  const add = (type: string, data: unknown = {}) => {
    const seq = events.length
    events.push({ seq, type, time: T0 + index * 100_000 + seq * 100, data })
    return seq
  }
  const content = (text: string) => [{ type: 'text', text }]
  const user = (text: string, source = 'user') => add('user/message', {
    id: `u${events.length}`, role: 'user', content: content(text), source: { kind: source },
  })
  const assistant = (text: string, turn: number, step: number) => add('assistant/message', {
    turn, step, message: { id: `a${events.length}`, role: 'assistant', content: content(text) }, stream: [],
  })
  const tool = (text: string, isError: boolean, callId: string) => add('tool/result', {
    message: { role: 'tool', toolCallId: callId, content: content(text), isError },
  })
  // 复盘逐项写出观察点，形成可切段的长正文；关键结论另放在末尾。
  const longPrefix = Array.from({ length: 18 }, (_, part) =>
    `第${part + 1}项观察：${scene.context[part % 4][1]}需要核对记录中的前后条件，保留未完成的检查项，下一步再逐项确认。\n`).join('')
  for (let turn = 0; turn < 12; turn++) {
    starts.push(add('turn/start', { turn }))
    if (index === 0 && turn === 0) user('请检查导入队列的日志并整理异常位置。委派任务验收编号为 JOB-17。')
    if (turn === 0) user(`宿主注入上下文：本轮主题为${scene.topic}。${index === 10 ? '宿主注入的环境标记为 ENV-Q7。' : ''}`, 'runtime-context')
    const slot = [1, 3, 6, 10].indexOf(turn)
    const item = slot >= 0 ? scene.cases[slot] : undefined
    user(scene.context[turn % 4][0])
    const category = slot >= 0 ? DIALOGUE_EVAL_CATEGORIES[Math.floor(index / 5) * 4 + slot] : undefined
    const first = assistant(item && category !== 'tool-result'
      ? (category === 'long-message' ? longPrefix : '') + item.answer
      : scene.context[turn % 4][1], turn, 1)
    if (item && category !== 'tool-result') refs.set(slot, first)
    const callId = `call-${turn}`
    add('tool/call', { callId, name: 'inspect', arguments: JSON.stringify({ topic: scene.topic, item: turn + 1 }) })
    const result = tool(category === 'tool-result' ? (index % 2 === 0 ? longPrefix : '') + item!.answer
      : `检查项 ${turn + 1}：${scene.topic}，记录完整，待确认结论。`, category === 'tool-result' && index % 2 === 0, callId)
    if (category === 'tool-result') refs.set(slot, result)
    if (item?.distractor) distractorSeq = assistant(item.distractor, turn, 2)
    assistant(scene.context[(turn + 1) % 4][1], turn, 3)
    if (turn === 11) {
      const longCallId = 'call-detail'
      add('tool/call', { callId: longCallId, name: 'inspect', arguments: '{"detail":true}' })
      tool(longPrefix + (index === 13 ? '露营清点暗格编号为 BOX-92。' : ''), false, longCallId)
    }
    ends.push(add('turn/end', { turn }))
  }
  sessions.push({ scene: kind, log: {
    header: { id: sessionId, isSeeded: false, ...(index === 0 ? { delegationDepth: 1 } : {}) },
    inheritedEventCount: 0, events,
  } })
  for (const [slot, item] of scene.cases.entries()) {
    const category = DIALOGUE_EVAL_CATEGORIES[Math.floor(index / 5) * 4 + slot]
    const query: DialogueEvalQuery = {
      id: `${category}-${index % 5 + 1}`, category, scene: kind, query: item.query,
      answers: category === 'no-answer' ? [] : [{ sessionId, seq: refs.get(slot)! }],
    }
    if (category === 'cross-word') query.distractors = [{ sessionId, seq: distractorSeq! }]
    if (category === 'before-anchor' || category === 'near-verbatim') {
      const anchorTurn = category === 'before-anchor' ? 7 + index % 4 : 10
      const id = `memory-${index + 1}-${slot}`
      query.anchorMemoryId = id
      memories.push({
        id, name: `${scene.topic}的${category === 'before-anchor' ? '后续安排' : '约定'}`,
        summary: category === 'before-anchor' ? scene.context[(anchorTurn + 1) % 4][1] : item.answer,
        body: category === 'before-anchor' ? scene.context[(anchorTurn + 1) % 4][1] : item.answer.replaceAll('，', '；'),
        sessionId, eventRange: [starts[anchorTurn], ends[anchorTurn]],
      })
    }
    queries.push(query)
  }
}

/** 十五份十二轮会话，办公占六成；不收录材料与真实候选放在同一日志里。 */
export const DIALOGUE_EVAL_SESSIONS: readonly EvalSession[] = sessions
/** 五个补找锚和五条近原文记忆，出处均落在对应会话自己的事件内。 */
export const DIALOGUE_EVAL_MEMORIES: readonly EvalMemory[] = memories
/** 六十道人工指定答案的题；空答案只表示该库无依据，不生成否定事实。 */
export const DIALOGUE_EVAL_QUERIES: readonly DialogueEvalQuery[] = queries
