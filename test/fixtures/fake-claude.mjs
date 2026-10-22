// A stand-in for `claude -p --input-format stream-json`: each user message starts a turn that asks for permission
// once; the answer finishes the turn. A message "exit" makes it exit (code 0) after a short pause.
import readline from 'node:readline';
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
let n = 0;
out({ type: 'system', subtype: 'init', model: 'fake', session_id: 'x' });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'user') {
    if (m.message.content === 'exit') { setTimeout(() => process.exit(0), 400); return; }
    n++;
    out({ type: 'stream_event', event: { type: 'message_start' } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'thinking' } } });
    out({ type: 'control_request', request_id: `r${n}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: `step ${n}` } } });
  } else if (m.type === 'control_response') {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: `done ${m.response.request_id}` }] } });
    out({ type: 'result', is_error: false, total_cost_usd: 0.01 });
  }
});
