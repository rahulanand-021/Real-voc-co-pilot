// AI instructions, categories, examples and answer formats (PRD section 10). Optimized for minimal token usage.

const CATEGORIES = [
  { id: 'onboarding_kyc', label: 'Onboarding / KYC', meaning: 'Sign-up, KYC, verification delays, or setup issues' },
  { id: 'login_access', label: 'Login / access', meaning: 'Login errors, OTP, PIN, biometrics, locked account' },
  { id: 'payments_deposits', label: 'Payments / deposits', meaning: 'Deposit failure, UPI/bank transfer issues, debited but not credited' },
  { id: 'withdrawals', label: 'Withdrawals', meaning: 'Withdrawal delays, failures, or redemption issues' },
  { id: 'orders_trading', label: 'Orders / trading', meaning: 'Placing/cancelling orders, pricing errors, execution failure' },
  { id: 'app_performance', label: 'App performance', meaning: 'Crashes, freezing, slowness, blank screens, bugs' },
  { id: 'customer_support', label: 'Customer support', meaning: 'Unresponsive support, unhelpful agents, open tickets' },
  { id: 'fees_charges', label: 'Fees / charges', meaning: 'Brokerage, hidden fees, penalties, unexpected deductions' },
  { id: 'ui_features', label: 'Design / features', meaning: 'Confusing UI, missing features, design feedback' },
  { id: 'trust_security', label: 'Trust / security', meaning: 'Scam worries, unauthorized actions, privacy concerns' },
  { id: 'other', label: 'Other', meaning: 'Relevant feedback fitting no specific category above' },
  { id: 'unclassified', label: 'Unclassified', meaning: 'Fallback code-only tag. Never output directly.' }
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
const AI_CATEGORY_IDS = CATEGORY_IDS.filter((id) => id !== 'unclassified');
const CHURN_TYPES = ['uninstall', 'competitor', 'refund_or_closure', 'last_chance', 'other'];

const TAGGING_INSTRUCTIONS = `Label Google Play reviews for a product team. Output valid JSON array only.
Rules:
1. analyzable: false if non-English/Devanagari script. If false, set skip_reason to "non_english", other fields null. Hinglish in Latin script is analyzable.
2. category: exactly one id from the list. If multiple, pick the primary complaint. Use "other" if none match.
3. sub_issue: under 6 words summarizing problem.
4. sentiment: negative, neutral, or positive.
5. severity: 1 (minor annoyance), 2 (blocks key task), 3 (financial/data loss or account lockout).
6. churn_signal: true only if user states intent to leave, uninstall, switch apps, or close account.
7. churn_type: uninstall, competitor, refund_or_closure, last_chance, or other. Null if churn_signal is false.
8. confidence: 0.0 to 1.0. Set <0.6 if ambiguous.
9. quote: exact verbatim substring (3-25 words) from text showing the issue. Never alter words.
10. Do not invent details. Base tags strictly on provided text.`;

const EXAMPLES = [
  {
    input: { review_id: 'ex1', rating: 1, text: 'Money debited but not credited to account. App keeps freezing, uninstalling today!' },
    output: { review_id: 'ex1', analyzable: true, category: 'payments_deposits', sub_issue: 'money debited not credited', sentiment: 'negative', severity: 3, churn_signal: true, churn_type: 'uninstall', confidence: 0.95, quote: 'Money debited but not credited to account' }
  }
];

function buildTaggingSystem() {
  const cats = CATEGORIES.filter((c) => c.id !== 'unclassified').map((c) => `${c.id}: ${c.meaning}`).join('\n');
  const ex = EXAMPLES.map((e, i) => `Ex ${i + 1} Input: ${JSON.stringify(e.input)}\nOutput: ${JSON.stringify(e.output)}`).join('\n');
  return `${TAGGING_INSTRUCTIONS}\n\nCategories:\n${cats}\n\nExample:\n${ex}`;
}

const TAGGING_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      review_id: { type: 'string' },
      analyzable: { type: 'boolean' },
      skip_reason: { type: 'string', enum: ['non_english'] },
      category: { type: 'string', enum: AI_CATEGORY_IDS },
      sub_issue: { type: 'string' },
      sentiment: { type: 'string', enum: ['negative', 'neutral', 'positive'] },
      severity: { type: 'integer', minimum: 1, maximum: 3 },
      churn_signal: { type: 'boolean' },
      churn_type: { type: 'string', enum: CHURN_TYPES },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      quote: { type: 'string' }
    },
    required: ['review_id', 'analyzable']
  }
};

const RECOMMENDATION_INSTRUCTIONS = `Write concise PM roadmap recommendations for the top issues. Output JSON array only.
Rules:
1. Use only provided input numbers. Do not calculate or invent numbers.
2. Base actions strictly on provided quotes and categories.
3. rationale: max 30 words on user struggle and count affected.
4. suggested_action: max 25 words on one concrete, testable fix.
5. metric_to_watch: max 10 words on measurable KPI.
6. evidence_review_ids: 1-3 review_ids from quotes.`;

const RECOMMENDATION_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      rank: { type: 'integer', minimum: 1, maximum: 3 },
      category: { type: 'string' },
      rationale: { type: 'string' },
      suggested_action: { type: 'string' },
      metric_to_watch: { type: 'string' },
      evidence_review_ids: { type: 'array', items: { type: 'string' } }
    },
    required: ['rank', 'category', 'rationale', 'suggested_action', 'metric_to_watch', 'evidence_review_ids']
  }
};

module.exports = {
  CATEGORIES, CATEGORY_IDS, AI_CATEGORY_IDS, CHURN_TYPES,
  TAGGING_INSTRUCTIONS, EXAMPLES, buildTaggingSystem, TAGGING_SCHEMA,
  RECOMMENDATION_INSTRUCTIONS, RECOMMENDATION_SCHEMA
};
