// 待处理 tab 的用例按功能拆在 test-pending-*.tsx，由这个入口加载：共用一个浏览器环境，不多起几份 jsdom。
import './test-pending-actions.tsx'
import './test-pending-advice.tsx'
import './test-pending-edit.tsx'
import './test-pending-navigation.tsx'
import './test-pending-proposals.tsx'
import './test-pending-suggestions.tsx'
import './test-pending-groups.tsx'
import './test-pending-findings.tsx'
