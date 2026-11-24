import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SUBAGENT_MAX_SAVES_DEFAULT, type PipelineResult } from '../pipeline.ts'
import { executeSave, renderSaveResult, type SaveToolDeps } from './save.ts'
import { toToolOutput } from './output.ts'
import { VALIDITY_DATE_FORMAT, VALIDITY_FORMAT } from '../validity.ts'
import { CHANGE_KINDS } from '../record-schema.ts'
import { LINKS_PER_KIND_MAX } from '../links.ts'

/** 整条写入才必填的字段共用的说明：参数表里都是可选，必填项由管线按 action 校验。 */
const WHOLE_WRITE = 'create 和整条 update 必填；用 edits 时不传就保留原值。'

/**
 * 子 agent 会话里的写入规则（工具说明只有一份，各会话共用，所以写成条件段）。
 * 子 agent 收到的是委派方裁剪过的任务，存下的记录先待确认，由委派方决定去留。
 * 配额写缺省值和配置项名，不写现值：改配额不用重注册工具，超额时拒绝原因里带实际上限。
 */
const SUBAGENT_RULES = `子 agent 会话里：只能新建 knowledge、project 两类，且要在当前场景里；project 只记观察到的项目状态，不记决定和目标。每个子会话新建有上限（默认 ${SUBAGENT_MAX_SAVES_DEFAULT} 条，可在配置 subagent.maxSavesPerSession 改）。存下的记录是待确认，不进主会话注入；存完在回复里报出 id 和摘要，由委派方决定接受、改写或丢弃。`

/**
 * 把 memory_save 工具接到 dsh 框架上。纯逻辑在 save.ts，不依赖框架包，测试直接测它；
 * 本文件由 typecheck + 真机验证保证。allowSubagent 为真时说明带子 agent 规则段（子 agent 写入随治理开关，见 index.ts）。
 */
export function createSaveTool(deps: SaveToolDeps, options: { allowSubagent?: boolean } = {}): ToolDefinition {
  const typeNames = deps.registry.all().map(t => t.name)
  const description = deps.registry.renderSaveDescription()
  return defineTool({
    name: 'memory_save',
    description: options.allowSubagent ? `${description}\n${SUBAGENT_RULES}` : description,
    parameters: {
      // dsh 参数 DSL：漏写 required: true 即为可选。name、type、scope、content、summary 只在整条写入时必填（edits 时可省），由管线按 action 校验
      action: { type: 'string', enum: ['create', 'update'], required: true },
      id: { type: 'string', description: 'action=update 时必填，目标记忆 id' },
      change: { type: 'string', enum: [...CHANGE_KINDS], description: 'action=update 时必填（只补挂 related、premises 的除外）：这次改动的性质，决定旧内容怎么处置。corroborate（补证）：同一件事又被提到，内容不用改；只刷新确认时间、记下这次的出处，正文等内容参数不生效，只传 id 和 sourceMode。refine（细化）：旧内容仍全部成立，补上条件、原因、步骤、例外；只增不删。correct（纠错）：旧内容当时就不对，直接改掉，不留历史。state-change（状态变化）：旧内容当时成立、现在变了；旧内容整条留成历史版本，这条记忆换成现在的状态。拿不准旧内容当时成不成立，填 state-change。' },
      changeReason: { type: 'string', description: 'change=state-change 时填：一句话说明为什么变了，随历史版本留着。' },
      name: { type: 'string', description: `简短标题（2-16 字）。${WHOLE_WRITE}` },
      type: { type: 'string', enum: typeNames, description: WHOLE_WRITE },
      scope: { type: 'string', enum: ['global', 'workspace'], description: WHOLE_WRITE },
      content: { type: 'string', description: `整条正文，会替换原来的全部正文；只改其中几处用 edits。按所选类型说明里的「正文」写法组织：结论在前，类型说明里的「原因：」「依据：」「背景：」接在句号后面，同一段写完、不换行（类型说明没写正文写法的，写清事实和它的依据或情境）。用第三人称陈述句并标明主体（「用户…」「项目定了…」），提到用户时每次都写「用户」，不用「他」「她」代称，日后读到时能和用户当下的话分开。用自己的话概括清楚，去掉口语和语气词；补充说明直接写进句子，正文里不加括号补注：别名和缩写放进 tags，日期按对话里的精度写，对话里没提到的细节直接略过；人名、地名、数字、单位、命令和路径照原样写，不概括成类别；适用范围和确定程度照对话里的写。正文只写这件事本身：这条是用户告诉你的、什么时候记的，记录会自动保存；第三方出处（同事、文档、通知）照常写进正文或「依据：」；写记忆时的操作经过（写入被拒、重试）留在会话里。只写对话或资料里有依据的内容，不替用户编理由。怎么用由类型统一交代，正文里不另列泛泛的使用场景和注意事项；不写行号、临时路径这类很快过时的细节，改用稳定的位置描述。完整经过可以用 memory_source 回查，不用抄进正文。提到别的记忆时写它的名称，不写记忆 id。${WHOLE_WRITE}` },
      edits: {
        type: 'array',
        description: '只改正文里的几处时用（配 action=update，不传 content）。按顺序应用，后一处匹配的是前一处改完的正文；任一处不成立，整次都不写。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            oldString: { type: 'string', required: true, description: '要替换的原文，从当前正文原样摘取（标点、空格、换行一致）。在正文里只能出现一次，出现多次就多带些前后文。' },
            newString: { type: 'string', required: true, description: '换成的文字；删掉这段就填空字符串。' },
            replaceAll: { type: 'boolean', description: 'oldString 出现多次、每处都要换时填 true。' },
          },
        },
      },
      summary: { type: 'string', description: `一句话说清这条记忆讲什么，显示在索引里，供人和模型判断相关不相关；不复述 name，不堆关键词。${WHOLE_WRITE}` },
      tags: { type: 'array', items: { type: 'string' }, description: '只写正文、name、summary 里都没出现、但以后可能被拿来搜它的词：同义词、中英文别名、缩写。不写泛化概念。用 edits 时不传就保留原标签。' },
      sourceMode: { type: 'string', enum: ['user-explicit', 'user-behavior', 'environment-observed', 'agent-inferred', 'agent-action-confirmed'], required: true, description: '信息从哪来，决定置信度上限。user-explicit：用户明说的。agent-action-confirmed：你做的事经用户确认有效，或被采纳。user-behavior：用户反复做出的动作（多次改写、撤销、拒绝同一类做法）；对一次举动揣测动机不算。environment-observed：从文件、命令输出、配置里直接读到的事实。agent-inferred：你自己的推断和解读；只要中间有一步是你推出来的、不是直接看到的，就填它。' },
      confidence: { type: 'number', description: '取值 0–1（0.9=确定，0.5=推测）。越界会被夹到边界、不报错，所以想表达低置信就填小值，别填 0 以上的整数' },
      supersedes: { type: 'array', items: { type: 'string' }, description: '被这条新记忆取代的旧记忆 id（action=create 时用）。旧的随即失效、不再带入；旧说法要留档时用它，只是补充或改正同一条用 action=update。' },
      validFrom: { type: 'string', description: `生效起始，本机时间。只有用户说了从什么时候开始才填；只有截止时间的，填 validTo 就够。用户说了具体时刻写 "${VALIDITY_FORMAT}"，没说就只写日期 "${VALIDITY_DATE_FORMAT}"，插件补上现在的时分。` },
      validTo: { type: 'string', description: `失效截止，本机时间。只有用户明确给了截止时间，或信息本身有确定的到期日（一次活动、临时方案）才填，其余不填。用户说了具体时刻写 "${VALIDITY_FORMAT}"（如「今天下午三点前」写 "2026-10-29 15:00"），没说就只写日期 "${VALIDITY_DATE_FORMAT}"，插件补上现在的时分；截止在今天的必须写时刻。必须晚于现在和 validFrom。到点后这条记忆不再带入新对话，也搜不到；已带入当前对话的，到下个会话或上下文压缩后才去掉。` },
      allowSecret: { type: 'boolean', description: '内容里有疑似密钥会被拦下；向用户确认不是密钥后，带 true 重发。明确的密钥一律不存。' },
      force: { type: 'boolean', description: '新建时内容和某条已有记忆几乎一样会被拦下；确认这是另一件事后，带 true 重发这次 create。' },
      related: { type: 'array', items: { type: 'string' }, description: `相关记忆的 id：这条记忆和它们说的是相关的事（比如一条决定改变了某个项目的现状），以后查到其中一条能顺着找到另一条。追加在已有的后面，已有的保留；每条最多 ${LINKS_PER_KIND_MAX} 个。项目记忆能指向本项目和全局的在用记忆，全局记忆只能指向全局记忆。新建、整条 update 时可一起传；给已有记忆补挂时，action=update 只传 id、sourceMode 和 related，不用填 change，内容保持原样。` },
      premises: { type: 'array', items: { type: 'string' }, description: `这条决定依据的记忆 id（type=decision 时用）：插件记下每条依据当时的内容，依据以后变了能看出来。追加规则、作用域和补挂方式同 related，每条最多 ${LINKS_PER_KIND_MAX} 个。` },
      confirmGlobal: { type: 'string', description: '确认改写全局记忆时用：原样填这条记忆最近一次未保存提示里给的确认码；第一次调用不填。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderSaveResult(value as unknown as PipelineResult) }],
    },
    execute: async (args, exec) => toToolOutput(await executeSave(args, exec, deps)),
  })
}
