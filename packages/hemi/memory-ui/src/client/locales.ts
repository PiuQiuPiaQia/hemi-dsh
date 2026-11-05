/** English dictionary for the feature controls. */
export const en = {
  nav: 'Memory',
  description: 'View and edit the Markdown memory Hemi shares across conversations.',
  automation: 'Saved memory is loaded for each turn. Context compaction saves a handoff. Closing the conversation runtime or quitting the app can summarize important information into the daily log.',
  usage: 'Automatic summaries use the most recently used model. Their usage is recorded by model. Missing provider usage is shown as unavailable.',
  store: 'Memory type',
  long_term: 'Long-term memory',
  daily: 'Daily log',
  scratchpad: 'Scratchpad',
  date: 'Log date',
  content: 'Memory content',
  placeholder: 'This memory file is empty.',
  loading: 'Loading…',
  loadFailed: 'Could not load this memory file.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  saveFailed: 'Could not save your changes.',
  conflict: 'The file changed after you opened it. Copy your edits before reloading.',
  reload: 'Reload',
  discard: 'Discard edits and reload',
  unsaved: 'Save or discard your edits before switching files.',
}

/**
 * Keys accepted by the memory settings dictionary.
 */
export type MemoryLocaleKey = keyof typeof en

/** Chinese dictionary for the feature controls. */
export const zh: Record<MemoryLocaleKey, string> = {
  nav: '记忆',
  description: '查看和编辑 Hemi 跨会话使用的 Markdown 记忆。',
  automation: '每轮自动读取已保存的记忆，长对话压缩时保存交接信息。会话运行结束或退出应用时，按需整理重要信息到每日日志。',
  usage: '自动摘要使用最近使用的模型。摘要用量按模型记录，模型未返回用量时会标记缺失。',
  store: '记忆类型',
  long_term: '长期记忆',
  daily: '每日日志',
  scratchpad: '便签',
  date: '日志日期',
  content: '记忆内容',
  placeholder: '这份记忆还是空的。',
  loading: '正在加载…',
  loadFailed: '无法读取这份记忆。',
  save: '保存',
  saving: '正在保存…',
  saved: '已保存',
  saveFailed: '无法保存修改。',
  conflict: '打开后，文件已被更新。请先复制你的修改，再重新加载。',
  reload: '重新加载',
  discard: '放弃修改并重新加载',
  unsaved: '请先保存或放弃修改，再切换文件。',
}
