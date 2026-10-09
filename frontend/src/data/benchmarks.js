// GreenCode AI — the four preloaded benchmark suites.
//
// Every benchmark is self-contained and deterministic so the Verifier can run
// the original and the optimized version side by side and diff their output.
// Code is stored with String.raw so backslashes survive untouched; benchmark
// sources deliberately avoid backticks and "${" so they embed safely here.
//
// Convention: stdout lines starting with "#METRIC" are excluded from the
// output-equivalence check and parsed as telemetry (e.g. LLM calls/tokens).

const pythonDataPipeline = String.raw`"""Benchmark 1 - Python data pipeline: order enrichment, dedup and regional totals."""
import random

random.seed(42)

N_CUSTOMERS = 2500
N_ORDERS = 5000

customers = [
    {"id": i, "name": "cust_%d" % i, "region": random.choice(["north", "south", "east", "west"])}
    for i in range(N_CUSTOMERS)
]
orders = [
    {"order_id": j, "customer_id": random.randrange(N_CUSTOMERS), "amount": round(random.uniform(5, 500), 2)}
    for j in range(N_ORDERS)
]
blocked_ids = [i for i in range(0, N_CUSTOMERS, 7)]

# Quadratic join: every order scans the full customer list - O(N * M)
enriched = []
for order in orders:
    for customer in customers:
        if order["customer_id"] == customer["id"]:
            enriched.append({**order, "region": customer["region"]})

# Nested list lookup: "not in" on a growing list - O(N^2)
active_customers = []
for row in enriched:
    if row["customer_id"] not in active_customers:
        active_customers.append(row["customer_id"])

# Linear membership test against a static list inside a loop - O(N * K)
allowed = []
for row in enriched:
    if row["customer_id"] not in blocked_ids:
        allowed.append(row)

totals = {}
for row in allowed:
    totals[row["region"]] = totals.get(row["region"], 0) + row["amount"]

print("enriched rows:", len(enriched))
print("active customers:", len(active_customers))
print("allowed rows:", len(allowed))
for region in sorted(totals):
    print(region, round(totals[region], 2))
`;

const pythonLlmLoop = String.raw`"""Benchmark 2 - Python LLM loop: support-ticket triage with an LLM classifier."""
import hashlib
import time


class MockLLMClient:
    """Deterministic offline stand-in for a hosted chat-completion API."""

    def __init__(self):
        self.calls = 0
        self.tokens = 0

    @staticmethod
    def _tokens(text):
        return max(1, len(text) // 4)

    def complete(self, system, user):
        self.calls += 1
        self.tokens += self._tokens(system) + self._tokens(user) + 4
        time.sleep(0.003)  # simulated network round-trip + inference latency
        digest = hashlib.sha256(user.strip().lower().encode()).hexdigest()
        return ["billing", "bug", "feature-request", "account"][int(digest, 16) % 4]


SYSTEM_PROMPT = """
You are a helpful, careful and precise customer support ticket classifier.
You are a helpful, careful and precise customer support ticket classifier.
Always read the ticket carefully before answering.
Always read the ticket carefully before answering.
Classify the ticket into exactly one of: billing, bug, feature-request, account.
Classify the ticket into exactly one of: billing, bug, feature-request, account.
Respond with the label only, in lowercase, with no punctuation.
Respond with the label only, in lowercase, with no punctuation.
Do not explain your reasoning.     Do not add any extra words.
Be accurate.        Be consistent.        Be concise.
Be accurate.        Be consistent.        Be concise.
Remember: billing, bug, feature-request, account are the only valid labels.
Remember: billing, bug, feature-request, account are the only valid labels.
"""

client = MockLLMClient()

TEMPLATES = [
    "I was charged twice for my subscription this month",
    "The export button crashes the app on Safari",
    "Please add dark mode to the dashboard",
    "I cannot reset my password, the email never arrives",
    "Refund request for the annual plan",
    "Upload fails for files larger than 10MB",
    "Can you support SSO with Okta?",
    "My account was locked after two login attempts",
]
tickets = [TEMPLATES[(i * 5) % len(TEMPLATES)] for i in range(160)]


def classify(ticket):
    # One network round-trip per ticket, full prompt resent every time, no cache.
    return client.complete(SYSTEM_PROMPT, ticket)


labels = []
for ticket in tickets:
    labels.append(classify(ticket))

counts = {}
for label in labels:
    counts[label] = counts.get(label, 0) + 1

print("tickets triaged:", len(labels))
for label in sorted(counts):
    print(label, counts[label])
print("#METRIC llm_calls=%d llm_tokens=%d" % (client.calls, client.tokens))
`;

const heavySql = String.raw`-- Benchmark 3 - Heavy SQL analytics query (SQLite dialect, self-seeding)
CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    signup_date TEXT NOT NULL
);

CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    order_date TEXT NOT NULL,
    total REAL NOT NULL,
    status TEXT NOT NULL
);

WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 4000)
INSERT INTO customers (id, name, country, signup_date)
SELECT n,
       'customer_' || n,
       CASE n % 4 WHEN 0 THEN 'IN' WHEN 1 THEN 'US' WHEN 2 THEN 'FR' ELSE 'DE' END,
       date('2020-01-01', '+' || (n % 1500) || ' days')
FROM seq;

WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 60000)
INSERT INTO orders (id, customer_id, order_date, total, status)
SELECT n,
       (n * 7919) % 4000 + 1,
       date('2022-01-01', '+' || (n % 1095) || ' days'),
       ROUND(((n * 37) % 1000) + 9.99, 2),
       CASE n % 5 WHEN 0 THEN 'refunded' ELSE 'paid' END
FROM seq;

-- Report: 2024 order count and paid revenue for every Indian customer
SELECT c.id,
       c.name,
       c.country,
       (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND strftime('%Y', o.order_date) = '2024') AS orders_2024,
       (SELECT SUM(o.total) FROM orders o WHERE o.customer_id = c.id AND strftime('%Y', o.order_date) = '2024' AND o.status = 'paid') AS revenue_2024
FROM customers c
WHERE c.country = 'IN'
ORDER BY revenue_2024 DESC, c.id
LIMIT 25;
`;

const jsFrontendLoop = String.raw`// Benchmark 4 - JavaScript frontend data loop: order table view-model
function makeData(nUsers, nOrders) {
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const users = [];
  for (let i = 0; i < nUsers; i++) {
    users.push({ id: i, name: 'user_' + i, tier: ['free', 'pro', 'team'][i % 3], prefs: { theme: 'dark', tags: ['a', 'b'] } });
  }
  const orders = [];
  for (let j = 0; j < nOrders; j++) {
    orders.push({ id: j, userId: Math.floor(rand() * nUsers), amount: Math.round(rand() * 50000) / 100 });
  }
  return { users, orders };
}

const { users, orders } = makeData(4000, 10000);

// Nested .find(): every order scans the whole user list - O(N * M)
// JSON round-trip deep clone allocates and re-parses a string per row
const rows = orders.map((order) => {
  const user = users.find((u) => u.id === order.userId);
  const snapshot = JSON.parse(JSON.stringify(user));
  return { ...order, userName: snapshot.name, tier: snapshot.tier, theme: snapshot.prefs.theme };
});

// Object spread inside .reduce(): copies the accumulator on every step - O(N^2)
const revenueByTier = rows.reduce((acc, row) => ({ ...acc, [row.tier]: (acc[row.tier] || 0) + row.amount }), {});
const ordersByUser = rows.reduce((acc, row) => ({ ...acc, [row.userId]: (acc[row.userId] || 0) + 1 }), {});

const tiers = Object.keys(revenueByTier).sort();
console.log('rows:', rows.length);
for (const tier of tiers) console.log(tier, revenueByTier[tier].toFixed(2));
console.log('distinct buyers:', Object.keys(ordersByUser).length);
console.log('top buyer orders:', Math.max(...Object.values(ordersByUser)));
`;

export const BENCHMARKS = [
  {
    id: 'py-pipeline',
    name: 'Python Data Pipeline',
    language: 'python',
    tagline: 'O(N²) quadratic join + nested list lookups',
    description:
      'Enriches 5,000 orders with customer data using a nested-loop join, then de-duplicates with list membership tests.',
    code: pythonDataPipeline,
  },
  {
    id: 'py-llm',
    name: 'Python LLM Loop',
    language: 'python',
    tagline: 'Unbatched calls, bloated prompt, no cache',
    description:
      'Classifies 160 support tickets with one LLM call each, re-sending a duplicated system prompt and never caching repeat tickets.',
    code: pythonLlmLoop,
  },
  {
    id: 'sql-heavy',
    name: 'Heavy SQL Query',
    language: 'sql',
    tagline: 'Missing indexes, wrapped date column, correlated subqueries',
    description:
      'Self-seeding SQLite analytics report with per-row correlated subqueries and a non-sargable strftime() predicate.',
    code: heavySql,
  },
  {
    id: 'js-frontend',
    name: 'JavaScript Frontend Loop',
    language: 'javascript',
    tagline: 'Nested .find(), spreads in .reduce(), JSON deep clone',
    description:
      'Builds a 10,000-row table view-model with nested lookups, JSON round-trip cloning and accumulator spreading.',
    code: jsFrontendLoop,
  },
];

export const LANGUAGES = [
  { id: 'python', label: 'Python' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'sql', label: 'SQL' },
];

export const getBenchmark = (id) => BENCHMARKS.find((b) => b.id === id);
