// Fake systemone judge for CLI tests. Binds 127.0.0.1 only; exits on SIGTERM.
//   --port <n>                      default 0 (ephemeral)
//   --key <k>                       accepted Bearer token (default: any request fails auth)
//   --served-model <id>             canonicalSlug reported back (default fake/jev)
//   --throttle-once 'retry-after=<v>'  first POST answers 429 with that Retry-After
// stdout: `listening http://127.0.0.1:<port>` first, then `auth ok` / `auth fail` per request.
// The key is never printed.
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '0' },
    key: { type: 'string' },
    'served-model': { type: 'string', default: 'fake/jev' },
    'throttle-once': { type: 'string' },
  },
});

const servedModel = values['served-model'];
const throttle = /^retry-after=(.+)$/.exec(values['throttle-once'] ?? '')?.[1];
let throttled = false;

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function answerFor(question) {
  if (question?.type === 'choice') {
    const names = Object.keys(question.criteria ?? {});
    const choice = names.includes('yes') ? 'yes' : (names[0] ?? 'yes');
    const probabilities = Object.fromEntries(names.map((name) => [name, 0]));
    probabilities[choice] = 0.9;
    return { type: 'choice', choice, confidence: 0.9, probabilities };
  }
  if (question?.type === 'score') {
    const levels = question.criteria ?? [];
    return {
      type: 'score',
      score: 0.9,
      confidence: 0.9,
      legend: Object.fromEntries(levels.map((text, i) => [String(i), text])),
      probabilities: Object.fromEntries(levels.map((_, i) => [String(i), i === 0 ? 0.9 : 0])),
    };
  }
  return { type: 'noul', noul: 0.9 };
}

const server = createServer((req, res) => {
  const authorized =
    values.key !== undefined && req.headers.authorization === `Bearer ${values.key}`;
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    // Presets probe health with a query string (openrouter: ?output_modalities=all).
    const url = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (
      !(req.method === 'POST' && url === '/v1/systemone') &&
      !(req.method === 'GET' && url === '/v1/models')
    ) {
      json(res, 404, { error: { type: 'not_found' } });
      return;
    }
    console.log(authorized ? 'auth ok' : 'auth fail');
    if (!authorized) {
      json(res, 401, { error: { type: 'authentication_error' } });
      return;
    }
    if (req.method === 'GET') {
      json(res, 200, { name: 'fake/jev' });
      return;
    }
    if (throttle !== undefined && !throttled) {
      throttled = true;
      json(res, 429, { error: { type: 'rate_limit_error' } }, { 'retry-after': throttle });
      return;
    }
    let questions = {};
    try {
      questions = JSON.parse(raw).questions ?? {};
    } catch {
      // an unparsable body gets an empty answer set
    }
    json(res, 200, {
      model: servedModel,
      answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, answerFor(q)])),
      usage: { input_tokens: 10, output_tokens: 1 },
      provider_metadata: { gateway: { routing: { canonicalSlug: servedModel } } },
    });
  });
});

server.listen(Number(values.port), '127.0.0.1', () => {
  console.log(`listening http://127.0.0.1:${server.address().port}`);
});
process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
