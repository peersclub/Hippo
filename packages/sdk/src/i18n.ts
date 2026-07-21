/**
 * SDK chrome localization. Scope is deliberately narrow: this translates only
 * the SDK's OWN static UI strings (header, composer, orders strip, hero,
 * buttons). It does NOT translate card CONTENT — the intelligence service
 * already generates briefs/declines in the trader's language ("language as a
 * generation parameter"), and the SDK only draws what the server sends.
 *
 * Consent/legal copy (the onboarding data rows, incl. the Layer-2 disclosure)
 * is intentionally EXCLUDED — it is counsel-owned (Open Decisions #2) and must
 * be translated under review, not here.
 *
 * hi (Devanagari), hi-Latn (Hinglish) and ar (Modern Standard Arabic) strings
 * are a FIRST PASS pending native review. Selecting `ar` also flips the panel
 * to right-to-left via `isRtl`.
 */

export const LOCALES = ['en', 'hi', 'hi-Latn', 'ar'] as const
export type Locale = (typeof LOCALES)[number]

const RTL_LOCALES: ReadonlySet<Locale> = new Set(['ar'])
export const isRtl = (locale: Locale): boolean => RTL_LOCALES.has(locale)

/** The full set of chrome message keys. `en` must define every one. */
export type MessageKey =
  | 'brand_ask'
  | 'header_subtitle'
  | 'hero_title'
  | 'composer_placeholder'
  | 'composer_placeholder_offline'
  | 'send'
  | 'retry_send'
  | 'send_failed'
  | 'orders_open'
  | 'orders_positions'
  | 'new_order'
  | 'new_order_hint'
  | 'manage_on' // interpolates {venue}
  | 'settings'
  | 'change_layout'
  | 'minimize'
  | 'connection_lost'
  | 'connection_lost_body'
  | 'feedback_helpful'
  | 'feedback_not_helpful'
  | 'order_filled'
  | 'journey_prepared'
  | 'journey_placing'
  | 'journey_working'
  | 'journey_filled'
  | 'journey_cancelling'
  | 'live_updates'
  | 'handed_off'
  | 'confirming'
  | 'ob_not_now'
  | 'ob_agree_start'
  | 'ob_replay'
  | 'suggestions_label'
  | 'chip_edit_hint'
  | 'composer_placeholder_connecting'
  | 'jump_latest'
  | 'queued_note' // interpolates {n}
  | 'ticket_offline_hint'
  | 'action_failed'
  | 'thread_label'
  | 'intro_dialog'
  | 'share_card'
  | 'close_settings'
  | 'close_share'
  | 'settings_language'
  | 'settings_memory_title'
  | 'settings_memory_body'
  | 'clear_memory'
  | 'clear_memory_confirm'
  | 'clear_memory_cancel'
  | 'clear_memory_done'
  | 'copy_brief'
  | 'copied'
  | 'stop_streaming'
  | 'composer_placeholder_unavailable'
  | 'composer_placeholder_capacity'
  | 'capacity_title'
  | 'capacity_body'

type Catalog = Record<MessageKey, string>

const en: Catalog = {
  brand_ask: 'Ask Hippo',
  header_subtitle: 'MARKET INTELLIGENCE',
  hero_title: 'Ask your market anything.',
  composer_placeholder: 'Ask about any market…',
  composer_placeholder_offline: "Reconnecting — you can't send right now",
  send: 'Send',
  retry_send: 'Retry send',
  send_failed: 'SEND FAILED — your message is kept. Tap ↻ to retry.',
  orders_open: 'OPEN ORDERS',
  orders_positions: 'POSITIONS',
  new_order: '+ New order',
  new_order_hint: 'Tell me what to place…',
  manage_on: 'Manage on {venue} →',
  settings: 'Settings',
  change_layout: 'Change layout',
  minimize: 'Minimize',
  connection_lost: 'CONNECTION LOST',
  connection_lost_body: 'Reconnecting — your thread is safe, and nothing you typed is lost.',
  feedback_helpful: 'Helpful',
  feedback_not_helpful: 'Not helpful',
  order_filled: 'Order filled',
  journey_prepared: 'PREPARED',
  journey_placing: 'PLACING',
  journey_working: 'WORKING',
  journey_filled: 'FILLED',
  journey_cancelling: 'CANCELLING',
  live_updates: 'LIVE · UPDATES AUTOMATICALLY',
  handed_off: 'HANDED OFF ✓',
  confirming: 'CONFIRMING…',
  ob_not_now: 'Not now',
  ob_agree_start: 'Agree & start',
  ob_replay: 'Replay the intro',
  suggestions_label: 'Suggested questions',
  chip_edit_hint: 'Hold to edit before sending',
  composer_placeholder_connecting: 'Connecting…',
  jump_latest: 'LATEST',
  queued_note: '{n} QUEUED — will send when reconnected',
  ticket_offline_hint: 'Reconnect to confirm orders',
  action_failed: "Couldn't reach the venue — nothing was sent. Tap to retry.",
  thread_label: 'Conversation',
  intro_dialog: 'Introduction',
  share_card: 'Share card',
  close_settings: 'Close settings',
  close_share: 'Close share card',
  settings_language: 'Answer language',
  settings_memory_title: 'Personal memory',
  settings_memory_body: 'Hippo remembers your preferences and past questions.',
  clear_memory: 'Clear everything Hippo remembers',
  clear_memory_confirm: 'Yes, clear it',
  clear_memory_cancel: 'Keep it',
  clear_memory_done: 'CLEARED ✓',
  copy_brief: 'Copy this brief',
  copied: 'Copied',
  stop_streaming: 'Stop generating',
  composer_placeholder_unavailable: 'Hippo isn’t available right now',
  composer_placeholder_capacity: 'Hippo is busy this month',
  capacity_title: 'HIPPO IS BUSY THIS MONTH',
  capacity_body:
    'Hippo has reached this month’s capacity. Your thread is safe — please check back soon.',
}

// First pass — pending native review.
const hi: Catalog = {
  brand_ask: 'Hippo से पूछें',
  header_subtitle: 'मार्केट इंटेलिजेंस',
  hero_title: 'अपने बाज़ार से कुछ भी पूछें।',
  composer_placeholder: 'किसी भी बाज़ार के बारे में पूछें…',
  composer_placeholder_offline: 'फिर से जुड़ रहे हैं — अभी आप भेज नहीं सकते',
  send: 'भेजें',
  retry_send: 'दोबारा भेजें',
  send_failed: 'भेजना विफल — आपका संदेश सुरक्षित है। दोबारा भेजने के लिए ↻ दबाएँ।',
  orders_open: 'खुले ऑर्डर',
  orders_positions: 'पोज़िशन',
  new_order: '+ नया ऑर्डर',
  new_order_hint: 'बताएँ क्या ऑर्डर करना है…',
  manage_on: '{venue} पर प्रबंधित करें →',
  settings: 'सेटिंग्स',
  change_layout: 'लेआउट बदलें',
  minimize: 'छोटा करें',
  connection_lost: 'कनेक्शन टूट गया',
  connection_lost_body: 'फिर से जुड़ रहे हैं — आपकी बातचीत सुरक्षित है, और आपने जो लिखा वह नहीं खोएगा।',
  feedback_helpful: 'उपयोगी',
  feedback_not_helpful: 'उपयोगी नहीं',
  order_filled: 'ऑर्डर पूरा हुआ',
  journey_prepared: 'तैयार',
  journey_placing: 'भेजा जा रहा',
  journey_working: 'सक्रिय',
  journey_filled: 'पूरा',
  journey_cancelling: 'रद्द हो रहा',
  live_updates: 'लाइव · अपने आप अपडेट होगा',
  handed_off: 'भेज दिया ✓',
  confirming: 'कन्फर्म हो रहा है…',
  ob_not_now: 'अभी नहीं',
  ob_agree_start: 'सहमत हूँ, शुरू करें',
  ob_replay: 'परिचय दोबारा देखें',
  suggestions_label: 'सुझाए गए प्रश्न',
  chip_edit_hint: 'भेजने से पहले बदलने के लिए दबाए रखें',
  composer_placeholder_connecting: 'जुड़ रहे हैं…',
  jump_latest: 'नवीनतम',
  queued_note: '{n} कतार में — दोबारा जुड़ते ही भेज दिए जाएँगे',
  ticket_offline_hint: 'ऑर्डर कन्फर्म करने के लिए दोबारा जुड़ें',
  action_failed: 'वेन्यू तक नहीं पहुँच सके — कुछ नहीं भेजा गया। दोबारा कोशिश करें।',
  thread_label: 'बातचीत',
  intro_dialog: 'परिचय',
  share_card: 'शेयर कार्ड',
  close_settings: 'सेटिंग्स बंद करें',
  close_share: 'शेयर कार्ड बंद करें',
  settings_language: 'उत्तर की भाषा',
  settings_memory_title: 'व्यक्तिगत मेमोरी',
  settings_memory_body: 'Hippo आपकी पसंद और पिछले प्रश्न याद रखता है।',
  clear_memory: 'Hippo की सारी यादें मिटाएँ',
  clear_memory_confirm: 'हाँ, मिटाएँ',
  clear_memory_cancel: 'रहने दें',
  clear_memory_done: 'मिटा दिया ✓',
  copy_brief: 'यह ब्रीफ़ कॉपी करें',
  copied: 'कॉपी हो गया',
  stop_streaming: 'जनरेट करना रोकें',
  composer_placeholder_unavailable: 'Hippo अभी उपलब्ध नहीं है',
  composer_placeholder_capacity: 'Hippo इस महीने व्यस्त है',
  capacity_title: 'Hippo इस महीने व्यस्त है',
  capacity_body: 'Hippo इस महीने की क्षमता तक पहुँच गया है। आपकी बातचीत सुरक्षित है — कृपया कुछ देर बाद देखें।',
}

// First pass — Hinglish (romanized), pending native review. Common product
// terms (order, market, settings) are kept in English, as Indian traders use.
const hiLatn: Catalog = {
  brand_ask: 'Hippo se poochho',
  header_subtitle: 'MARKET INTELLIGENCE',
  hero_title: 'Apne market se kuch bhi poochho.',
  composer_placeholder: 'Kisi bhi market ke baare mein poochho…',
  composer_placeholder_offline: 'Reconnect ho raha hai — abhi bhej nahi sakte',
  send: 'Bhejo',
  retry_send: 'Dobara bhejo',
  send_failed: 'SEND FAIL — aapka message safe hai. Retry ke liye ↻ dabao.',
  orders_open: 'OPEN ORDERS',
  orders_positions: 'POSITIONS',
  new_order: '+ Naya order',
  new_order_hint: 'Batao kya order karna hai…',
  manage_on: '{venue} par manage karo →',
  settings: 'Settings',
  change_layout: 'Layout badlo',
  minimize: 'Chhota karo',
  connection_lost: 'CONNECTION TOOT GAYA',
  connection_lost_body:
    'Reconnect ho raha hai — aapki baat-cheet safe hai, jo likha wo nahi khoyega.',
  feedback_helpful: 'Useful',
  feedback_not_helpful: 'Useful nahi',
  order_filled: 'Order fill ho gaya',
  journey_prepared: 'READY',
  journey_placing: 'BHEJ RAHE',
  journey_working: 'ACTIVE',
  journey_filled: 'FILL',
  journey_cancelling: 'CANCEL HO RAHA',
  live_updates: 'LIVE · APNE AAP UPDATE HOGA',
  handed_off: 'BHEJ DIYA ✓',
  confirming: 'CONFIRM HO RAHA…',
  ob_not_now: 'Abhi nahi',
  ob_agree_start: 'Agree karke shuru karo',
  ob_replay: 'Intro dobara dekho',
  suggestions_label: 'Suggested questions',
  chip_edit_hint: 'Bhejne se pehle edit karne ke liye dabaye rakho',
  composer_placeholder_connecting: 'Connect ho raha hai…',
  jump_latest: 'LATEST',
  queued_note: '{n} QUEUE mein — reconnect hote hi bhej denge',
  ticket_offline_hint: 'Order confirm karne ke liye reconnect karo',
  action_failed: 'Venue tak nahi pahunch sake — kuch nahi bheja gaya. Retry karo.',
  thread_label: 'Baat-cheet',
  intro_dialog: 'Intro',
  share_card: 'Share card',
  close_settings: 'Settings band karo',
  close_share: 'Share card band karo',
  settings_language: 'Answer language',
  settings_memory_title: 'Personal memory',
  settings_memory_body: 'Hippo aapki preferences aur pichhle questions yaad rakhta hai.',
  clear_memory: 'Hippo ki saari memory clear karo',
  clear_memory_confirm: 'Haan, clear karo',
  clear_memory_cancel: 'Rehne do',
  clear_memory_done: 'CLEAR HO GAYA ✓',
  copy_brief: 'Yeh brief copy karo',
  copied: 'Copy ho gaya',
  stop_streaming: 'Generate karna roko',
  composer_placeholder_unavailable: 'Hippo abhi available nahi hai',
  composer_placeholder_capacity: 'Hippo is mahine busy hai',
  capacity_title: 'Hippo IS MAHINE BUSY HAI',
  capacity_body:
    'Hippo is mahine ki capacity tak pahunch gaya hai. Aapki baat-cheet safe hai — thodi der baad dekhein.',
}

// First pass — pending native review. Modern Standard Arabic; the brand word
// "Hippo" stays in Latin script, and numerals stay Western (0-9) so figures
// match the card content the server sends.
const ar: Catalog = {
  brand_ask: 'اسأل Hippo',
  header_subtitle: 'ذكاء السوق',
  hero_title: 'اسأل سوقك عن أي شيء.',
  composer_placeholder: 'اسأل عن أي سوق…',
  composer_placeholder_offline: 'جارٍ إعادة الاتصال — لا يمكنك الإرسال الآن',
  send: 'إرسال',
  retry_send: 'إعادة الإرسال',
  send_failed: 'فشل الإرسال — رسالتك محفوظة. اضغط ↻ لإعادة المحاولة.',
  orders_open: 'الأوامر المفتوحة',
  orders_positions: 'المراكز',
  new_order: '+ أمر جديد',
  new_order_hint: 'أخبرني بما تريد تنفيذه…',
  manage_on: 'الإدارة على {venue} ←',
  settings: 'الإعدادات',
  change_layout: 'تغيير التخطيط',
  minimize: 'تصغير',
  connection_lost: 'انقطع الاتصال',
  connection_lost_body: 'جارٍ إعادة الاتصال — محادثتك آمنة، ولن يضيع أي شيء كتبته.',
  feedback_helpful: 'مفيد',
  feedback_not_helpful: 'غير مفيد',
  order_filled: 'تم تنفيذ الأمر',
  journey_prepared: 'جاهز',
  journey_placing: 'جارٍ الإرسال',
  journey_working: 'نشط',
  journey_filled: 'منفذ',
  journey_cancelling: 'جارٍ الإلغاء',
  live_updates: 'مباشر · يتحدث تلقائيًا',
  handed_off: 'تم الإرسال ✓',
  confirming: 'جارٍ التأكيد…',
  ob_not_now: 'ليس الآن',
  ob_agree_start: 'أوافق وأبدأ',
  ob_replay: 'إعادة عرض المقدمة',
  suggestions_label: 'أسئلة مقترحة',
  chip_edit_hint: 'اضغط مطولًا للتعديل قبل الإرسال',
  composer_placeholder_connecting: 'جارٍ الاتصال…',
  jump_latest: 'الأحدث',
  queued_note: '{n} في قائمة الانتظار — سيتم الإرسال عند إعادة الاتصال',
  ticket_offline_hint: 'أعد الاتصال لتأكيد الأوامر',
  action_failed: 'تعذّر الوصول إلى المنصّة — لم يُرسَل شيء. اضغط لإعادة المحاولة.',
  thread_label: 'المحادثة',
  intro_dialog: 'المقدمة',
  share_card: 'مشاركة البطاقة',
  close_settings: 'إغلاق الإعدادات',
  close_share: 'إغلاق بطاقة المشاركة',
  settings_language: 'لغة الإجابات',
  settings_memory_title: 'الذاكرة الشخصية',
  settings_memory_body: 'يتذكر Hippo تفضيلاتك وأسئلتك السابقة.',
  clear_memory: 'مسح كل ما يتذكره Hippo',
  clear_memory_confirm: 'نعم، امسحه',
  clear_memory_cancel: 'أبقِه',
  clear_memory_done: 'تم المسح ✓',
  copy_brief: 'نسخ هذا الموجز',
  copied: 'تم النسخ',
  stop_streaming: 'إيقاف التوليد',
  composer_placeholder_unavailable: 'Hippo غير متاح حاليًا',
  composer_placeholder_capacity: 'Hippo مشغول هذا الشهر',
  capacity_title: 'Hippo مشغول هذا الشهر',
  capacity_body: 'وصل Hippo إلى سعة هذا الشهر. محادثتك آمنة — يُرجى المحاولة لاحقًا.',
}

const CATALOGS: Record<Locale, Partial<Catalog>> = { en, hi, 'hi-Latn': hiLatn, ar }

/** Normalize an arbitrary locale string to a supported Locale; default en. */
export function resolveLocale(raw: string | null | undefined): Locale {
  if (!raw) return 'en'
  const v = raw.trim()
  // exact match first (handles 'hi-Latn')
  if ((LOCALES as readonly string[]).includes(v)) return v as Locale
  const lower = v.toLowerCase()
  if (lower === 'hi-latn' || lower === 'hi_latn') return 'hi-Latn'
  const primary = lower.split(/[-_]/)[0]
  if (primary === 'hi') return 'hi'
  if (primary === 'ar') return 'ar'
  return 'en'
}

/** Look up a chrome string, falling back to en, then to the key itself.
 *  Interpolates {name} placeholders from `vars`. */
export function t(locale: Locale, key: MessageKey, vars?: Record<string, string>): string {
  const raw = CATALOGS[locale]?.[key] ?? en[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name) => vars[name] ?? m)
}
