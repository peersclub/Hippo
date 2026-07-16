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
 * hi (Devanagari) and hi-Latn (Hinglish) strings are a FIRST PASS pending
 * native review. `ar` is present as RTL groundwork: no copy yet (falls back to
 * en), but selecting it flips the panel to right-to-left via `isRtl`.
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
  | 'ob_not_now'
  | 'ob_agree_start'
  | 'ob_replay'

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
  ob_not_now: 'Not now',
  ob_agree_start: 'Agree & start',
  ob_replay: 'Replay the intro',
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
  ob_not_now: 'अभी नहीं',
  ob_agree_start: 'सहमत हूँ, शुरू करें',
  ob_replay: 'परिचय दोबारा देखें',
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
  ob_not_now: 'Abhi nahi',
  ob_agree_start: 'Agree karke shuru karo',
  ob_replay: 'Intro dobara dekho',
}

/** ar: RTL groundwork only — no copy yet, falls back to en, but flips layout. */
const ar: Partial<Catalog> = {}

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
