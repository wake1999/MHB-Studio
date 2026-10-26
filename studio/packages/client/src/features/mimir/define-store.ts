/**
 * `@deepseek-ai/dsh-client-store` 的最小本地替身。
 *
 * 上游只用到 `defineStore({ init, actions })` 这一种用法：init 给出初始状态，
 * actions 是一组「拿到草稿就改」的纯函数，React 侧靠 getSnapshot/subscribe 读取。
 * 这里按同样语义实现（每次 action 复制一份草稿再提交），这样上游的 store.ts 可以
 * 原样保留，只把 import 指到本文件。
 */

export interface EngineStoreHandle<S, A> {
  readonly getSnapshot: () => S
  readonly subscribe: (listener: () => void) => () => void
  readonly actions: A
}

type DraftAction<S, Args extends unknown[]> = (draft: S, ...args: Args) => void

type ActionSpec<A> = {
  [K in keyof A]: A[K] extends (...args: infer P) => void ? DraftAction<Record<string, unknown>, P> : never
}

export function defineStore<S extends object, A extends Record<string, (...args: never[]) => void>>(spec: {
  init: () => S
  actions: ActionSpec<A>
}): EngineStoreHandle<S, A> {
  let state: S = spec.init()
  const listeners = new Set<() => void>()
  const actions = {} as A

  for (const [name, action] of Object.entries(spec.actions)) {
    actions[name as keyof A] = ((...args: unknown[]) => {
      const draft = { ...state }
      ;(action as (draft: S, ...rest: unknown[]) => void)(draft, ...args)
      state = draft
      for (const listener of [...listeners]) listener()
    }) as A[keyof A]
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    actions,
  }
}
