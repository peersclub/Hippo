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
  | 'understood'
  | 'memory_applied'
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
  | 'settings_glass_title'
  | 'settings_glass_body'
  | 'clear_memory'
  | 'clear_memory_confirm'
  | 'clear_memory_cancel'
  | 'clear_memory_done'
  | 'learned_memory_title'
  | 'learned_group_remembered'
  | 'learned_group_session'
  | 'learned_clear'
  | 'learned_toggle_title'
  | 'learned_off'
  | 'copy_brief'
  | 'copied'
  | 'stop_streaming'
  | 'composer_placeholder_unavailable'
  | 'composer_placeholder_capacity'
  | 'capacity_title'
  | 'capacity_body'
  | 'draft_pair'
  | 'draft_order_type'
  | 'draft_type_market'
  | 'draft_type_limit'
  | 'draft_price'
  | 'draft_price_market'
  | 'draft_size'
  | 'draft_leverage'
  | 'draft_margin'
  | 'draft_margin_isolated'
  | 'draft_margin_cross'
  | 'draft_stop_loss'
  | 'draft_take_profit'
  | 'draft_dismiss'
  | 'draft_dismissed'
  | 'draft_sent'
  | 'dismiss'
  | 'id_section'
  | 'id_firstrun_title'
  | 'id_firstrun_cta'
  | 'id_mode_create'
  | 'id_mode_signin'
  | 'id_username_label'
  | 'id_pin_label'
  | 'id_submit_create'
  | 'id_submit_signin'
  | 'id_checking'
  | 'id_taken'
  | 'id_wrong_pin'
  | 'id_invalid'
  | 'id_rate_limited'
  | 'id_signed_out'
  | 'id_signed_in_as' // interpolates {username}
  | 'id_sign_out'
  | 'upload_attach'
  | 'upload_uploading'
  | 'upload_too_large_csv'
  | 'upload_too_large_image'
  | 'upload_unsupported'
  | 'upload_send_failed'
  | 'upload_received'
  | 'upload_analyzing'
  | 'upload_analyzed'
  | 'upload_failed'
  | 'upload_retry'
  | 'files_title'
  | 'files_open'
  | 'files_loading'
  | 'files_error'
  | 'files_retry'
  | 'files_empty'
  | 'files_close'
  | 'journey_placed'
  | 'order_in_flight'
  | 'host_action_chart'
  | 'host_action_indicator'
  | 'host_action_pending'
  | 'host_action_applied'
  | 'host_action_failed'
  | 'host_action_timeout'
  | 'orders_summary_all'
  | 'orders_summary_session'
  | 'orders_total_working'
  | 'orders_total_filled'
  | 'orders_total_cancelled'
  | 'orders_summary_empty_all'
  | 'orders_summary_empty_session'
  | 'alert_eyebrow'
  | 'alert_cancel'
  | 'alert_state_armed'
  | 'alert_state_triggered'
  | 'alert_state_cancelled'
  | 'clarify_eyebrow'
  | 'clarify_you_said'
  | 'clarify_chosen'
  | 'clarify_sending'
  | 'clarify_offline_hint'
  | 'clarify_failed'
  // Neutral positions empty state — deliberately claims NOTHING about the
  // account (an empty frame can be a failed fetch, not a flat book).
  | 'positions_empty'

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
  understood: 'UNDERSTOOD',
  memory_applied: 'Memory applied:',
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
  settings_glass_title: 'Transparent panel',
  settings_glass_body:
    'Frosted glass — keep your exchange visible behind the panel. Drag it anywhere by its header.',
  clear_memory: 'Clear everything Hippo remembers',
  clear_memory_confirm: 'Yes, clear it',
  clear_memory_cancel: 'Keep it',
  clear_memory_done: 'CLEARED ✓',
  learned_memory_title: 'What Hippo remembers about you',
  learned_group_remembered: 'Remembered',
  learned_group_session: 'This chat',
  learned_clear: 'Clear what Hippo remembers',
  learned_toggle_title: 'Remember my preferences',
  learned_off: 'Preference memory is off — Hippo won’t learn from this chat.',
  copy_brief: 'Copy this brief',
  copied: 'Copied',
  stop_streaming: 'Stop generating',
  composer_placeholder_unavailable: 'Hippo isn’t available right now',
  composer_placeholder_capacity: 'Hippo is busy this month',
  capacity_title: 'HIPPO IS BUSY THIS MONTH',
  capacity_body:
    'Hippo has reached this month’s capacity. Your thread is safe — please check back soon.',
  draft_pair: 'Pair',
  draft_order_type: 'Order type',
  draft_type_market: 'Market',
  draft_type_limit: 'Limit',
  draft_price: 'Price',
  draft_price_market: '≈ market',
  draft_size: 'Size',
  draft_leverage: 'Leverage',
  draft_margin: 'Margin',
  draft_margin_isolated: 'Isolated',
  draft_margin_cross: 'Cross',
  draft_stop_loss: 'Stop loss',
  draft_take_profit: 'Take profit',
  draft_dismiss: 'Dismiss',
  draft_dismissed: 'Order draft dismissed',
  draft_sent: 'SENT ✓',
  dismiss: 'Dismiss',
  id_section: 'Identity',
  id_firstrun_title: 'Claim a username so Hippo remembers you anywhere',
  id_firstrun_cta: 'Claim username',
  id_mode_create: 'Create',
  id_mode_signin: 'Sign in',
  id_username_label: 'Username',
  id_pin_label: '4-digit PIN',
  id_submit_create: 'Claim it',
  id_submit_signin: 'Sign in',
  id_checking: 'CHECKING…',
  id_taken: 'That username is taken — sign in instead, or pick another.',
  id_wrong_pin: 'Wrong PIN — try again.',
  id_invalid: 'Usernames are 3–24 letters, numbers, - or _; the PIN is 4 digits.',
  id_rate_limited: 'Too many attempts — please wait a bit, then try again.',
  id_signed_out: 'Signed out ✓',
  id_signed_in_as: 'Signed in as {username}',
  id_sign_out: 'Sign out',
  upload_attach: 'Attach a CSV or image',
  upload_uploading: 'UPLOADING',
  upload_too_large_csv: 'CSV files up to 512 KB can be analyzed — this one is larger.',
  upload_too_large_image: 'Images up to 3 MB can be analyzed — this one is larger.',
  upload_unsupported: 'Only CSV, PNG, JPEG or WebP files can be analyzed.',
  upload_send_failed: 'Upload failed — nothing reached Hippo. Try again.',
  upload_received: 'RECEIVED',
  upload_analyzing: 'ANALYZING…',
  upload_analyzed: 'ANALYZED ✓',
  upload_failed: 'UPLOAD FAILED',
  upload_retry: 'Retry',
  files_title: 'Files',
  files_open: 'Your uploaded files',
  files_loading: 'Loading your files…',
  files_error: "Couldn't load files",
  files_retry: 'Try again',
  files_empty: 'Nothing uploaded yet — attach a CSV or image from the composer.',
  files_close: 'Close files',
  journey_placed: 'PLACED',
  order_in_flight: 'ORDER IN FLIGHT — AWAITING THE VENUE…',
  host_action_chart: 'Chart',
  host_action_indicator: 'Indicator',
  host_action_pending: 'Sending to chart…',
  host_action_applied: 'Applied ✓',
  host_action_failed: "Host didn't apply this",
  host_action_timeout: 'No response from page',
  orders_summary_all: 'All orders',
  orders_summary_session: 'This session',
  orders_total_working: 'Working',
  orders_total_filled: 'Filled',
  orders_total_cancelled: 'Cancelled',
  orders_summary_empty_all: 'No orders yet',
  orders_summary_empty_session: 'No orders this session',
  alert_eyebrow: 'PRICE ALERT',
  alert_cancel: 'CANCEL ALERT',
  alert_state_armed: 'ARMED',
  alert_state_triggered: 'TRIGGERED',
  alert_state_cancelled: 'CANCELLED',
  clarify_eyebrow: 'BEFORE I ACT',
  clarify_you_said: 'You said',
  clarify_chosen: 'YOU CHOSE',
  clarify_sending: 'SENDING…',
  clarify_offline_hint: 'Reconnect to answer this',
  clarify_failed: "Couldn't send your choice — nothing was decided. Tap again.",
  positions_empty: 'Nothing to show',
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
  understood: 'समझ लिया',
  memory_applied: 'लागू मेमोरी:',
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
  settings_glass_title: 'पारदर्शी पैनल',
  settings_glass_body: 'फ्रॉस्टेड ग्लास — पैनल के पीछे आपका एक्सचेंज दिखता रहे। हेडर से इसे कहीं भी खींचें।',
  clear_memory: 'Hippo की सारी यादें मिटाएँ',
  clear_memory_confirm: 'हाँ, मिटाएँ',
  clear_memory_cancel: 'रहने दें',
  clear_memory_done: 'मिटा दिया ✓',
  learned_memory_title: 'Hippo आपके बारे में क्या याद रखता है',
  learned_group_remembered: 'याद रखा गया',
  learned_group_session: 'इस चैट में',
  learned_clear: 'Hippo जो याद रखता है उसे मिटाएँ',
  learned_toggle_title: 'मेरी पसंद याद रखें',
  learned_off: 'पसंद की मेमोरी बंद है — Hippo इस चैट से कुछ नहीं सीखेगा।',
  copy_brief: 'यह ब्रीफ़ कॉपी करें',
  copied: 'कॉपी हो गया',
  stop_streaming: 'जनरेट करना रोकें',
  composer_placeholder_unavailable: 'Hippo अभी उपलब्ध नहीं है',
  composer_placeholder_capacity: 'Hippo इस महीने व्यस्त है',
  capacity_title: 'Hippo इस महीने व्यस्त है',
  capacity_body: 'Hippo इस महीने की क्षमता तक पहुँच गया है। आपकी बातचीत सुरक्षित है — कृपया कुछ देर बाद देखें।',
  draft_pair: 'पेयर',
  draft_order_type: 'ऑर्डर प्रकार',
  draft_type_market: 'मार्केट',
  draft_type_limit: 'लिमिट',
  draft_price: 'कीमत',
  draft_price_market: '≈ मार्केट',
  draft_size: 'मात्रा',
  draft_leverage: 'लीवरेज',
  draft_margin: 'मार्जिन',
  draft_margin_isolated: 'आइसोलेटेड',
  draft_margin_cross: 'क्रॉस',
  draft_stop_loss: 'स्टॉप लॉस',
  draft_take_profit: 'टेक प्रॉफ़िट',
  draft_dismiss: 'हटाएँ',
  draft_dismissed: 'ऑर्डर ड्राफ़्ट हटा दिया गया',
  draft_sent: 'भेज दिया ✓',
  dismiss: 'हटाएँ',
  id_section: 'पहचान',
  id_firstrun_title: 'एक username चुनें ताकि Hippo आपको हर जगह याद रखे',
  id_firstrun_cta: 'Username चुनें',
  id_mode_create: 'नया बनाएँ',
  id_mode_signin: 'साइन इन',
  id_username_label: 'Username',
  id_pin_label: '4 अंकों का PIN',
  id_submit_create: 'क्लेम करें',
  id_submit_signin: 'साइन इन करें',
  id_checking: 'जाँच हो रही है…',
  id_taken: 'यह username पहले से लिया गया है — साइन इन करें या दूसरा चुनें।',
  id_wrong_pin: 'गलत PIN — दोबारा कोशिश करें।',
  id_invalid: 'Username में 3–24 अक्षर, अंक, - या _ हों; PIN 4 अंकों का हो।',
  id_rate_limited: 'बहुत बार कोशिश हुई — थोड़ी देर बाद दोबारा कोशिश करें।',
  id_signed_out: 'साइन आउट हो गया ✓',
  id_signed_in_as: '{username} के रूप में साइन इन',
  id_sign_out: 'साइन आउट',
  upload_attach: 'CSV या इमेज जोड़ें',
  upload_uploading: 'अपलोड हो रहा है',
  upload_too_large_csv: 'सिर्फ़ 512 KB तक की CSV फ़ाइलें — यह उससे बड़ी है।',
  upload_too_large_image: 'सिर्फ़ 3 MB तक की इमेज — यह उससे बड़ी है।',
  upload_unsupported: 'सिर्फ़ CSV, PNG, JPEG या WebP फ़ाइलों का विश्लेषण हो सकता है।',
  upload_send_failed: 'अपलोड विफल — कुछ नहीं भेजा गया। दोबारा कोशिश करें।',
  upload_received: 'मिल गई',
  upload_analyzing: 'विश्लेषण हो रहा है…',
  upload_analyzed: 'विश्लेषण पूरा ✓',
  upload_failed: 'अपलोड विफल',
  upload_retry: 'दोबारा',
  files_title: 'फ़ाइलें',
  files_open: 'आपकी अपलोड की गई फ़ाइलें',
  files_loading: 'आपकी फ़ाइलें लोड हो रही हैं…',
  files_error: 'फ़ाइलें लोड नहीं हो सकीं',
  files_retry: 'दोबारा कोशिश करें',
  files_empty: 'अभी कुछ अपलोड नहीं हुआ — कंपोज़र से CSV या इमेज जोड़ें।',
  files_close: 'फ़ाइलें बंद करें',
  journey_placed: 'भेजा गया',
  order_in_flight: 'ऑर्डर भेजा गया — वेन्यू की प्रतीक्षा…',
  host_action_chart: 'चार्ट',
  host_action_indicator: 'इंडिकेटर',
  host_action_pending: 'चार्ट को भेजा जा रहा…',
  host_action_applied: 'लागू ✓',
  host_action_failed: 'होस्ट ने इसे लागू नहीं किया',
  host_action_timeout: 'पेज से कोई जवाब नहीं',
  orders_summary_all: 'सभी ऑर्डर',
  orders_summary_session: 'इस सत्र में',
  orders_total_working: 'सक्रिय',
  orders_total_filled: 'पूरा',
  orders_total_cancelled: 'रद्द',
  orders_summary_empty_all: 'अभी कोई ऑर्डर नहीं',
  orders_summary_empty_session: 'इस सत्र में कोई ऑर्डर नहीं',
  alert_eyebrow: 'मूल्य अलर्ट',
  alert_cancel: 'अलर्ट रद्द करें',
  alert_state_armed: 'सक्रिय',
  alert_state_triggered: 'ट्रिगर हुआ',
  alert_state_cancelled: 'रद्द',
  clarify_eyebrow: 'कुछ करने से पहले',
  clarify_you_said: 'आपने कहा',
  clarify_chosen: 'आपने चुना',
  clarify_sending: 'भेजा जा रहा है…',
  clarify_offline_hint: 'जवाब देने के लिए दोबारा जुड़ें',
  clarify_failed: 'आपका चुनाव भेजा नहीं जा सका — कुछ तय नहीं हुआ। दोबारा दबाएँ।',
  positions_empty: 'दिखाने के लिए कुछ नहीं',
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
  understood: 'SAMJHA',
  memory_applied: 'Memory applied:',
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
  settings_glass_title: 'Transparent panel',
  settings_glass_body:
    'Frosted glass — panel ke peeche apna exchange dikhta rahe. Header se kahin bhi drag karo.',
  clear_memory: 'Hippo ki saari memory clear karo',
  clear_memory_confirm: 'Haan, clear karo',
  clear_memory_cancel: 'Rehne do',
  clear_memory_done: 'CLEAR HO GAYA ✓',
  learned_memory_title: 'Hippo aapke baare mein kya yaad rakhta hai',
  learned_group_remembered: 'Yaad rakha',
  learned_group_session: 'Is chat mein',
  learned_clear: 'Hippo jo yaad rakhta hai wo clear karo',
  learned_toggle_title: 'Meri preferences yaad rakho',
  learned_off: 'Preference memory off hai — Hippo is chat se kuch nahi seekhega.',
  copy_brief: 'Yeh brief copy karo',
  copied: 'Copy ho gaya',
  stop_streaming: 'Generate karna roko',
  composer_placeholder_unavailable: 'Hippo abhi available nahi hai',
  composer_placeholder_capacity: 'Hippo is mahine busy hai',
  capacity_title: 'Hippo IS MAHINE BUSY HAI',
  capacity_body:
    'Hippo is mahine ki capacity tak pahunch gaya hai. Aapki baat-cheet safe hai — thodi der baad dekhein.',
  // Product terms (pair, market, limit, leverage, margin) stay in English —
  // that's how Indian traders actually say them.
  draft_pair: 'Pair',
  draft_order_type: 'Order type',
  draft_type_market: 'Market',
  draft_type_limit: 'Limit',
  draft_price: 'Price',
  draft_price_market: '≈ market',
  draft_size: 'Quantity',
  draft_leverage: 'Leverage',
  draft_margin: 'Margin',
  draft_margin_isolated: 'Isolated',
  draft_margin_cross: 'Cross',
  draft_stop_loss: 'Stop loss',
  draft_take_profit: 'Take profit',
  draft_dismiss: 'Hatao',
  draft_dismissed: 'Order draft hata diya',
  draft_sent: 'BHEJ DIYA ✓',
  dismiss: 'Hatao',
  id_section: 'Identity',
  id_firstrun_title: 'Username claim karo taaki Hippo aapko har jagah yaad rakhe',
  id_firstrun_cta: 'Username claim karo',
  id_mode_create: 'Naya banao',
  id_mode_signin: 'Sign in',
  id_username_label: 'Username',
  id_pin_label: '4-digit PIN',
  id_submit_create: 'Claim karo',
  id_submit_signin: 'Sign in karo',
  id_checking: 'CHECK HO RAHA…',
  id_taken: 'Yeh username pehle se liya hai — sign in karo ya doosra chuno.',
  id_wrong_pin: 'Galat PIN — dobara try karo.',
  id_invalid: 'Username 3–24 letters, numbers, - ya _ ka ho; PIN 4 digit ka.',
  id_rate_limited: 'Bahut baar try hua — thodi der baad dobara try karo.',
  id_signed_out: 'Sign out ho gaya ✓',
  id_signed_in_as: '{username} ke roop mein signed in',
  id_sign_out: 'Sign out',
  upload_attach: 'CSV ya image attach karo',
  upload_uploading: 'UPLOAD HO RAHA',
  upload_too_large_csv: 'Sirf 512 KB tak ki CSV files — yeh usse badi hai.',
  upload_too_large_image: 'Sirf 3 MB tak ki images — yeh usse badi hai.',
  upload_unsupported: 'Sirf CSV, PNG, JPEG ya WebP files analyze ho sakti hain.',
  upload_send_failed: 'Upload fail — kuch nahi bheja gaya. Dobara try karo.',
  upload_received: 'MIL GAYI',
  upload_analyzing: 'ANALYZE HO RAHA…',
  upload_analyzed: 'ANALYZED ✓',
  upload_failed: 'UPLOAD FAIL',
  upload_retry: 'Retry',
  files_title: 'Files',
  files_open: 'Aapki uploaded files',
  files_loading: 'Aapki files load ho rahi hain…',
  files_error: 'Files load nahi ho sakin',
  files_retry: 'Dobara try karo',
  files_empty: 'Abhi kuch upload nahi hua — composer se CSV ya image attach karo.',
  files_close: 'Files band karo',
  // Lifecycle vocabulary stays in English product terms, like FILL above.
  journey_placed: 'PLACED',
  order_in_flight: 'Order bhej diya — venue ka wait…',
  // Product terms (chart, indicator) stay in English, like the rest above.
  host_action_chart: 'Chart',
  host_action_indicator: 'Indicator',
  host_action_pending: 'Chart ko bhej rahe…',
  host_action_applied: 'Applied ✓',
  host_action_failed: 'Host ne ise apply nahi kiya',
  host_action_timeout: 'Page se koi jawab nahi',
  orders_summary_all: 'Saare orders',
  orders_summary_session: 'Is session mein',
  orders_total_working: 'Working',
  orders_total_filled: 'Filled',
  orders_total_cancelled: 'Cancelled',
  orders_summary_empty_all: 'Abhi koi order nahi',
  orders_summary_empty_session: 'Is session mein koi order nahi',
  alert_eyebrow: 'PRICE ALERT',
  alert_cancel: 'ALERT CANCEL KAREIN',
  alert_state_armed: 'ACTIVE',
  alert_state_triggered: 'TRIGGER HUA',
  alert_state_cancelled: 'CANCEL',
  clarify_eyebrow: 'KUCH KARNE SE PEHLE',
  clarify_you_said: 'Aapne kaha',
  clarify_chosen: 'AAPNE CHUNA',
  clarify_sending: 'BHEJA JA RAHA HAI…',
  clarify_offline_hint: 'Jawab dene ke liye dobara connect karo',
  clarify_failed: 'Aapka choice bhej nahi paye — kuch tay nahi hua. Dobara tap karo.',
  positions_empty: 'Dikhane ke liye kuch nahi',
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
  understood: 'فهمت',
  memory_applied: 'الذاكرة المطبّقة:',
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
  settings_glass_title: 'لوحة شفافة',
  settings_glass_body:
    'زجاج مصنفر — تبقى بيانات منصتك مرئية خلف اللوحة. اسحبها إلى أي مكان من ترويستها.',
  clear_memory: 'مسح كل ما يتذكره Hippo',
  clear_memory_confirm: 'نعم، امسحه',
  clear_memory_cancel: 'أبقِه',
  clear_memory_done: 'تم المسح ✓',
  learned_memory_title: 'ما يتذكره Hippo عنك',
  learned_group_remembered: 'محفوظ',
  learned_group_session: 'هذه المحادثة',
  learned_clear: 'امسح ما يتذكره Hippo',
  learned_toggle_title: 'تذكّر تفضيلاتي',
  learned_off: 'ذاكرة التفضيلات متوقفة — لن يتعلّم Hippo من هذه المحادثة.',
  copy_brief: 'نسخ هذا الموجز',
  copied: 'تم النسخ',
  stop_streaming: 'إيقاف التوليد',
  composer_placeholder_unavailable: 'Hippo غير متاح حاليًا',
  composer_placeholder_capacity: 'Hippo مشغول هذا الشهر',
  capacity_title: 'Hippo مشغول هذا الشهر',
  capacity_body: 'وصل Hippo إلى سعة هذا الشهر. محادثتك آمنة — يُرجى المحاولة لاحقًا.',
  draft_pair: 'الزوج',
  draft_order_type: 'نوع الأمر',
  draft_type_market: 'سوق',
  draft_type_limit: 'محدد',
  draft_price: 'السعر',
  draft_price_market: '≈ سعر السوق',
  draft_size: 'الكمية',
  draft_leverage: 'الرافعة المالية',
  draft_margin: 'الهامش',
  draft_margin_isolated: 'معزول',
  draft_margin_cross: 'مشترك',
  draft_stop_loss: 'وقف الخسارة',
  draft_take_profit: 'جني الأرباح',
  draft_dismiss: 'تجاهل',
  draft_dismissed: 'تم تجاهل مسودة الأمر',
  draft_sent: 'تم الإرسال ✓',
  dismiss: 'إغلاق',
  id_section: 'الهوية',
  id_firstrun_title: 'احجز اسم مستخدم ليتذكرك Hippo في كل مكان',
  id_firstrun_cta: 'احجز اسم مستخدم',
  id_mode_create: 'إنشاء',
  id_mode_signin: 'تسجيل الدخول',
  id_username_label: 'اسم المستخدم',
  id_pin_label: 'رمز PIN من 4 أرقام',
  id_submit_create: 'احجزه',
  id_submit_signin: 'سجّل الدخول',
  id_checking: 'جارٍ التحقق…',
  id_taken: 'اسم المستخدم هذا محجوز — سجّل الدخول أو اختر اسمًا آخر.',
  id_wrong_pin: 'رمز PIN خاطئ — حاول مرة أخرى.',
  id_invalid: 'اسم المستخدم من 3–24 حرفًا أو رقمًا أو - أو _؛ والرمز 4 أرقام.',
  id_rate_limited: 'محاولات كثيرة — يُرجى الانتظار قليلًا ثم المحاولة مجددًا.',
  id_signed_out: 'تم تسجيل الخروج ✓',
  id_signed_in_as: 'مسجّل الدخول باسم {username}',
  id_sign_out: 'تسجيل الخروج',
  upload_attach: 'أرفق ملف CSV أو صورة',
  upload_uploading: 'جارٍ الرفع',
  upload_too_large_csv: 'ملفات CSV حتى 512 KB فقط — هذا الملف أكبر.',
  upload_too_large_image: 'الصور حتى 3 MB فقط — هذه الصورة أكبر.',
  upload_unsupported: 'يمكن تحليل ملفات CSV وPNG وJPEG وWebP فقط.',
  upload_send_failed: 'فشل الرفع — لم يصل شيء. حاول مرة أخرى.',
  upload_received: 'استُلم',
  upload_analyzing: 'جارٍ التحليل…',
  upload_analyzed: 'تم التحليل ✓',
  upload_failed: 'فشل الرفع',
  upload_retry: 'إعادة المحاولة',
  files_title: 'الملفات',
  files_open: 'ملفاتك المرفوعة',
  files_loading: 'جارٍ تحميل ملفاتك…',
  files_error: 'تعذّر تحميل الملفات',
  files_retry: 'حاول مرة أخرى',
  files_empty: 'لا شيء مرفوع بعد — أرفق ملف CSV أو صورة من مربّع الكتابة.',
  files_close: 'إغلاق الملفات',
  journey_placed: 'أُرسل',
  order_in_flight: 'أُرسل أمرك — في انتظار المنصّة…',
  host_action_chart: 'الرسم البياني',
  host_action_indicator: 'المؤشر',
  host_action_pending: 'يُرسَل إلى الرسم البياني…',
  host_action_applied: 'تم التطبيق ✓',
  host_action_failed: 'لم تطبّق الصفحة هذا',
  host_action_timeout: 'لا استجابة من الصفحة',
  orders_summary_all: 'كل الأوامر',
  orders_summary_session: 'هذه الجلسة',
  orders_total_working: 'نشط',
  orders_total_filled: 'منفّذ',
  orders_total_cancelled: 'ملغى',
  orders_summary_empty_all: 'لا أوامر بعد',
  orders_summary_empty_session: 'لا أوامر في هذه الجلسة',
  alert_eyebrow: 'تنبيه السعر',
  alert_cancel: 'إلغاء التنبيه',
  alert_state_armed: 'مُفعّل',
  alert_state_triggered: 'تم التفعيل',
  alert_state_cancelled: 'ملغى',
  clarify_eyebrow: 'قبل أن أتصرف',
  clarify_you_said: 'قلت',
  clarify_chosen: 'اخترت',
  clarify_sending: 'جارٍ الإرسال…',
  clarify_offline_hint: 'أعد الاتصال للإجابة',
  clarify_failed: 'تعذّر إرسال اختيارك — لم يُتخذ أي إجراء. المس مرة أخرى.',
  positions_empty: 'لا شيء لعرضه',
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
