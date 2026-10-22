// Stands in for `codex exec --json`. FAKE_EXEC: 'ok' | 'fail' | 'reconnect' | 'reconnect-fail'; FAKE_EXEC_TEXT: the final message to send instead.
import fs from 'node:fs';
let input = '';
process.stdin.on('data', d => { input += d; }).on('end', () => {
  const out = o => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'thread.started', thread_id: 't1' });
  out({ type: 'turn.started' });
  if (process.env.FAKE_EXEC === 'reconnect' || process.env.FAKE_EXEC === 'reconnect-fail') out({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected)' });
  if (process.env.FAKE_EXEC === 'reconnect-fail') process.exit(1);
  if (process.env.FAKE_EXEC === 'fail') { out({ type: 'turn.failed', error: { message: 'Usage limit reached' } }); process.exit(1); }
  const args = process.argv.slice(2);
  const schemaAt = args.indexOf('--output-schema');
  const schema = schemaAt >= 0 ? JSON.parse(fs.readFileSync(args[schemaAt + 1], 'utf8')) : null; // what Codex would be held to
  const text = process.env.FAKE_EXEC_TEXT ?? JSON.stringify({ title: 'Fix login', args, schema });
  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } });
  out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
});
