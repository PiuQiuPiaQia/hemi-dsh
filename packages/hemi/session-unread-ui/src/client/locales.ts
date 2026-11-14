/** English dictionary defining the manual unread action keys. */
export const en = { markUnread: 'Mark as unread' }

/** Keys accepted by the unread menu dictionary. */
export type UnreadKey = keyof typeof en

/** Localized text for each supported application language. */
export const dictionaries = {
  en,
  zh: { markUnread: '标记为未读' },
  ja: { markUnread: '未読にする' },
  es: { markUnread: 'Marcar como no leído' },
  fr: { markUnread: 'Marquer comme non lu' },
  de: { markUnread: 'Als ungelesen markieren' },
  ru: { markUnread: 'Отметить как непрочитанное' },
  pt: { markUnread: 'Marcar como não lida' },
} satisfies Record<string, Record<UnreadKey, string>>
