// 环境声明：@deepseek-ai/dsh-client-runtime 不在本仓库内（外部发布包），
// 类型导入在构建时被擦除、运行时由 Web 应用提供。此处补齐编译期类型面。
declare module '@deepseek-ai/dsh-client-runtime/client' {
  import type { ComponentType } from 'react'

  export interface ClientSlotDefinition {
    name: string
    id: string
    order?: number
  }

  export interface ClientSlots {
    inject(slot: string, register: () => void): void
    register(def: ClientSlotDefinition, component: ComponentType): () => void
  }

  export interface ClientContext {
    slots: ClientSlots
  }
}
