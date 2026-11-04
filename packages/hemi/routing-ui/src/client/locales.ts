/** Locale bundles for the Hemi model routing settings section. */

/** Locale keys the section renders. */
export type RoutingLocaleKey =
  | 'nav' | 'title' | 'description' | 'restartNote'
  | 'followMain' | 'save' | 'saving' | 'saved' | 'saveFailed' | 'catalogError'
  | 'roleResearch' | 'roleReview' | 'roleExecution' | 'roleDesign'
  | 'roleResearchHelp' | 'roleReviewHelp' | 'roleExecutionHelp' | 'roleDesignHelp'

/** English copy. */
export const en: Record<RoutingLocaleKey, string> = {
  nav: 'Model routing',
  title: 'Model routing',
  description: 'Choose the model each delegation role uses. Routes must stay within the subagent models allowed on the Plugins page; roles set to "follow conversation" use this conversation\'s model.',
  restartNote: 'Saved routes apply to newly created sessions after restarting the app.',
  followMain: 'Follow conversation model',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  saveFailed: 'Save failed',
  catalogError: 'Could not load the model catalog. Retry after checking the model settings.',
  roleResearch: 'Research',
  roleReview: 'Review',
  roleExecution: 'Execution',
  roleDesign: 'Design',
  roleResearchHelp: 'Gathers context and summarizes findings.',
  roleReviewHelp: 'Critically reviews outputs and diffs.',
  roleExecutionHelp: 'Carries out the instructed changes.',
  roleDesignHelp: 'Works on the user-facing interface.',
}

/** Chinese copy. */
export const zh: Record<RoutingLocaleKey, string> = {
  nav: '模型路由',
  title: '模型路由',
  description: '为每个委派角色选择使用的模型。路由必须位于"插件"页允许的子代理模型集合内；设为"跟随会话模型"的角色使用当前会话模型。',
  restartNote: '保存的路由在重启应用后对新创建的会话生效。',
  followMain: '跟随会话模型',
  save: '保存',
  saving: '保存中…',
  saved: '已保存',
  saveFailed: '保存失败',
  catalogError: '模型目录加载失败。请检查模型设置后重试。',
  roleResearch: '研究',
  roleReview: '评审',
  roleExecution: '执行',
  roleDesign: '设计',
  roleResearchHelp: '收集上下文并汇总结论。',
  roleReviewHelp: '严格评审产出与变更。',
  roleExecutionHelp: '执行指示的多步改动。',
  roleDesignHelp: '负责用户界面的设计实现。',
}
