/** English dictionary for the feature controls. */
export const en = {
  nav: 'Memory',
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
