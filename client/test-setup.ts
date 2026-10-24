// client 组件测试的公共设置：jest-dom 断言，每个用例后卸载渲染树。
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => { cleanup() })
